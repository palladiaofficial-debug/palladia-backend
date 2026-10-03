'use strict';
// ── "Perché esci?" dopo l'uscita (F-265, AUDIT.md del frontend) ─────────────
// L'operaio ha GIÀ timbrato l'uscita (POST /scan, invariato). Qui, dopo,
// sceglie il motivo: pausa pranzo, maltempo o permesso ("fine giornata" non
// chiama niente). Il motivo va in presence_log_reasons (migrazioni 217/233),
// tabella separata mai letta dal pairing: le timbrature non cambiano.
//
// File separato da routes/v1/scan.js di proposito: la timbratura resta
// intoccata. Autenticazione identica a POST /scan/note (sessione dispositivo).
const crypto = require('crypto');
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const { scanLimiter } = require('../../middleware/rateLimit');
const { tagPresenceLogReason } = require('../../lib/presenceLogReasons');
const { entryNotExitDetails } = require('../../lib/punchGuard');

const REASONS = ['pausa', 'maltempo', 'permesso'];
const WINDOW_MS = 30 * 60 * 1000; // solo l'uscita appena fatta
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

router.post('/scan/exit-reason', scanLimiter, async (req, res) => {
  const { worksite_id, session_token, reason } = req.body || {};
  if (!worksite_id || !session_token) return res.status(400).json({ error: 'MISSING_FIELDS' });
  if (typeof session_token !== 'string' || session_token.length !== 64) return res.status(401).json({ error: 'INVALID_SESSION_TOKEN' });
  if (!REASONS.includes(reason)) return res.status(400).json({ error: 'INVALID_REASON', allowed: REASONS });

  const { data: session, error: sessErr } = await supabase
    .from('worker_device_sessions')
    .select('id, worker_id, company_id, expires_at, revoked_at')
    .eq('token_hash', hashToken(session_token))
    .maybeSingle();
  if (sessErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!session) return res.status(401).json({ error: 'INVALID_SESSION_TOKEN' });
  if (session.revoked_at) return res.status(401).json({ error: 'SESSION_REVOKED' });
  if (new Date(session.expires_at) < new Date()) return res.status(401).json({ error: 'SESSION_EXPIRED' });

  // L'ultima timbratura del lavoratore deve essere un'uscita, su questo
  // cantiere, fatta da poco: il motivo non può finire su un'uscita vecchia.
  const { data: last, error: lastErr } = await supabase
    .from('presence_logs')
    .select('id, event_type, site_id, timestamp_server')
    .eq('worker_id', session.worker_id)
    .eq('company_id', session.company_id)
    .order('timestamp_server', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!last || last.event_type !== 'EXIT' || last.site_id !== worksite_id) return res.status(409).json({ error: 'NO_RECENT_EXIT' });
  if (Date.now() - new Date(last.timestamp_server).getTime() > WINDOW_MS) return res.status(409).json({ error: 'EXIT_TOO_OLD' });

  // Già scelto lo stesso motivo: niente doppioni (es. doppio tocco)
  const { data: existing } = await supabase.from('presence_log_reasons')
    .select('reason').eq('presence_log_id', last.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existing?.reason === reason) return res.json({ ok: true, presence_log_id: last.id, unchanged: true });

  const r = await tagPresenceLogReason({ companyId: session.company_id, logId: last.id, reason, note: null, userId: null });
  if (!r.ok) return res.status(r.code === 'DB_ERROR' ? 500 : 400).json({ error: r.code });
  res.json({ ok: true, presence_log_id: last.id, at: last.timestamp_server });
});

// ── F-266: "No, sto andando via" dalla pagina QR ─────────────────────────────
// Alla domanda "Stai iniziando a lavorare?" (dopo un turno di pochi minuti
// oggi) l'operaio risponde che sta andando via: non si scrive nessuna
// timbratura, il titolare riceve un avviso con gli orari da correggere —
// stesso esito di help-request ENTRY_NOT_EXIT del badge personale.
router.post('/scan/help-entry-not-exit', scanLimiter, async (req, res) => {
  const { worksite_id, session_token } = req.body || {};
  if (!worksite_id || !session_token) return res.status(400).json({ error: 'MISSING_FIELDS' });
  if (typeof session_token !== 'string' || session_token.length !== 64) return res.status(401).json({ error: 'INVALID_SESSION_TOKEN' });

  const { data: session } = await supabase.from('worker_device_sessions')
    .select('worker_id, company_id, expires_at, revoked_at, worker:workers(full_name)')
    .eq('token_hash', hashToken(session_token)).maybeSingle();
  if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) return res.status(401).json({ error: 'INVALID_SESSION_TOKEN' });

  const { data: site } = await supabase.from('sites').select('name, company_id').eq('id', worksite_id).maybeSingle();
  if (!site || site.company_id !== session.company_id) return res.status(404).json({ error: 'WORKSITE_NOT_FOUND' });

  const details = await entryNotExitDetails({ workerId: session.worker_id, companyId: session.company_id });
  const name = session.worker?.full_name || 'Un operaio';
  const { error } = await supabase.from('notifications').insert({
    company_id: session.company_id, type: 'punch_help_request', severity: 'warning',
    title: `${name} sta andando via: timbrature di oggi da correggere`,
    body: `Cantiere: ${site.name}. ${details}`,
    entity_type: 'punch_help_request', entity_id: crypto.randomUUID(),
  });
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

module.exports = router;
