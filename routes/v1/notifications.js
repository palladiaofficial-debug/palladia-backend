'use strict';
/**
 * routes/v1/notifications.js
 * Notifiche in-app per scadenze (lavoratori, mezzi, documenti aziendali).
 *
 * GET    /api/v1/notifications          — lista + contatore non lette
 * GET    /api/v1/notifications/count    — solo contatore badge (non lette)
 * PATCH  /api/v1/notifications/:id/read — segna come letta
 * POST   /api/v1/notifications/read-all — segna tutte come lette
 * PATCH  /api/v1/notifications/:id/snooze  — "prenotato/in rinnovo", silenzia fino a una data
 * DELETE /api/v1/notifications/:id/snooze  — annulla lo snooze (torna ad allarme normale)
 * DELETE /api/v1/notifications/:id      — elimina singola notifica
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { isSnoozeActive } = require('../../services/expiryHelper');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SNOOZE_DAYS = 90; // stesso ordine di grandezza delle scadenze che questo alert copre — non un rinvio indefinito
const SNOOZABLE_TYPES = ['worker_doc_missing', 'worker_doc_expiry'];

// F-100 (AUDIT.md): scoped al proprio path — vedi archive.js per la spiegazione.
router.use('/notifications', verifySupabaseJwt);

// ── GET lista ─────────────────────────────────────────────────────────────────
router.get('/notifications', async (req, res) => {
  const userId = req.user?.id;
  const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200);

  const { data, error } = await supabase
    .from('notifications')
    .select('id, type, severity, title, body, entity_type, entity_id, read_by, created_at, updated_at, snoozed_until')
    .eq('company_id', req.companyId)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const notifications = (data || []).map(n => ({
    ...n,
    read: userId ? n.read_by.includes(userId) : false,
    read_by: undefined, // non esporre l'array raw al frontend
    // Il frontend non deve ricalcolare la regola "critical su worker_doc_expiry
    // non è mai snoozabile" — la espone qui, stessa fonte usata dai cron.
    snooze_active: isSnoozeActive({ snoozedUntil: n.snoozed_until, type: n.type, severity: n.severity }),
  }));

  const unread = notifications.filter(n => !n.read).length;
  res.json({ notifications, unread });
});

// ── GET contatore badge ────────────────────────────────────────────────────────
router.get('/notifications/count', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.json({ unread: 0 });

  const { data, error } = await supabase
    .from('notifications')
    .select('read_by')
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const unread = (data || []).filter(n => !n.read_by.includes(userId)).length;
  res.json({ unread });
});

// ── PATCH segna come letta ────────────────────────────────────────────────────
router.patch('/notifications/:id/read', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'UNAUTHENTICATED' });

  // Aggiungi user_id a read_by (Postgres array_append idempotente via RPC non disponibile,
  // usiamo update diretto: leggi + aggiungi se non presente)
  const { data: notif } = await supabase
    .from('notifications')
    .select('id, read_by')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (!notif) return res.status(404).json({ error: 'NOT_FOUND' });

  if (notif.read_by.includes(userId)) return res.json({ ok: true }); // già letta

  const { error } = await supabase
    .from('notifications')
    .update({ read_by: [...notif.read_by, userId] })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── PATCH snooze — "prenotato, in fase di rinnovo" ────────────────────────────
// Solo owner/admin/tech (stesso ruolo che riceve queste notifiche via
// getCompanyAdminEmails) — un lavoratore non deve poter silenziare da solo
// l'alert sulla propria idoneità mancante. Sempre a scadenza esplicita, mai
// indefinito: allo scadere di `until` l'alert riprende da solo.
router.patch('/notifications/:id/snooze', async (req, res) => {
  if (!['owner', 'admin', 'tech'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN', required_role: ['owner', 'admin', 'tech'] });
  }
  const { until } = req.body || {};
  if (!until || !DATE_RE.test(until)) {
    return res.status(400).json({ error: 'INVALID_PARAMS', message: 'until (YYYY-MM-DD) obbligatorio' });
  }
  const todayStr = new Date().toISOString().split('T')[0];
  if (until <= todayStr) {
    return res.status(400).json({ error: 'INVALID_PARAMS', message: 'until deve essere una data futura' });
  }
  const maxStr = new Date(Date.now() + MAX_SNOOZE_DAYS * 86400000).toISOString().split('T')[0];
  if (until > maxStr) {
    return res.status(400).json({ error: 'INVALID_PARAMS', message: `until non può superare ${MAX_SNOOZE_DAYS} giorni da oggi` });
  }

  const { data: notif } = await supabase
    .from('notifications')
    .select('id, type, severity')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();
  if (!notif) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!SNOOZABLE_TYPES.includes(notif.type)) {
    return res.status(400).json({ error: 'NOT_SNOOZABLE', message: 'Questo tipo di notifica non può essere prenotato.' });
  }
  // Un worker_doc_expiry già davvero scaduto non è mai silenziabile — stesso
  // criterio di isSnoozeActive/shouldSendTelegram, verificato qui PRIMA di
  // scrivere per non dare all'utente un falso senso di "gestito".
  if (notif.type === 'worker_doc_expiry' && notif.severity === 'critical') {
    return res.status(400).json({ error: 'ALREADY_EXPIRED', message: 'Il documento è già scaduto — non può essere prenotato, solo caricato/rinnovato.' });
  }

  const { error } = await supabase
    .from('notifications')
    .update({ snoozed_until: until, snoozed_by: req.user.id })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true, snoozed_until: until });
});

// ── DELETE snooze — torna ad allarme normale ──────────────────────────────────
router.delete('/notifications/:id/snooze', async (req, res) => {
  if (!['owner', 'admin', 'tech'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN', required_role: ['owner', 'admin', 'tech'] });
  }
  const { error } = await supabase
    .from('notifications')
    .update({ snoozed_until: null, snoozed_by: null })
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── POST segna tutte come lette ───────────────────────────────────────────────
router.post('/notifications/read-all', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'UNAUTHENTICATED' });

  // Recupera tutte le notifiche non lette da questo utente
  const { data: unread } = await supabase
    .from('notifications')
    .select('id, read_by')
    .eq('company_id', req.companyId)
    .not('read_by', 'cs', `{${userId}}`);

  if (!unread?.length) return res.json({ ok: true, updated: 0 });

  // Aggiorna in parallelo
  await Promise.all(unread.map(n =>
    supabase.from('notifications')
      .update({ read_by: [...n.read_by, userId] })
      .eq('id', n.id)
  ));

  res.json({ ok: true, updated: unread.length });
});

// ── DELETE ────────────────────────────────────────────────────────────────────
router.delete('/notifications/:id', async (req, res) => {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.status(204).end();
});

module.exports = router;
