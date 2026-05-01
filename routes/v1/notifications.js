'use strict';
/**
 * routes/v1/notifications.js
 * Notifiche in-app per scadenze (lavoratori, mezzi, documenti aziendali).
 *
 * GET    /api/v1/notifications         — lista + contatore non lette
 * GET    /api/v1/notifications/count   — solo contatore badge (non lette)
 * PATCH  /api/v1/notifications/:id/read — segna come letta
 * POST   /api/v1/notifications/read-all — segna tutte come lette
 * DELETE /api/v1/notifications/:id     — elimina singola notifica
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

router.use(verifySupabaseJwt);

// ── GET lista ─────────────────────────────────────────────────────────────────
router.get('/notifications', async (req, res) => {
  const userId = req.user?.id;
  const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200);

  const { data, error } = await supabase
    .from('notifications')
    .select('id, type, severity, title, body, entity_type, entity_id, read_by, created_at, updated_at')
    .eq('company_id', req.companyId)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const notifications = (data || []).map(n => ({
    ...n,
    read: userId ? n.read_by.includes(userId) : false,
    read_by: undefined, // non esporre l'array raw al frontend
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
