'use strict';
// ── Gestione sessioni dispositivo lavoratori ───────────────────────────────
// Endpoint privati (JWT) per admin/tecnici:
//   GET  /api/v1/workers/:workerId/sessions  — lista sessioni di un lavoratore
//   DELETE /api/v1/sessions/:sessionId       — revoca una sessione (es. telefono perso)
// ──────────────────────────────────────────────────────────────────────────
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { auditLog }          = require('../../lib/audit');

// GET /api/v1/workers/:workerId/sessions — sessioni attive/storiche (PRIVATO)
router.get('/workers/:workerId/sessions', verifySupabaseJwt, async (req, res) => {
  const { workerId } = req.params;

  // Verifica che il worker appartenga alla company autenticata
  const { data: worker, error: wErr } = await supabase
    .from('workers')
    .select('id, full_name')
    .eq('id', workerId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (wErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!worker) return res.status(404).json({ error: 'WORKER_NOT_FOUND' });

  const { data, error } = await supabase
    .from('worker_device_sessions')
    .select('id, issued_at, last_seen_at, expires_at, revoked_at')
    .eq('worker_id', workerId)
    .eq('company_id', req.companyId)
    .order('issued_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  const now = new Date();
  res.json({
    worker: { id: worker.id, full_name: worker.full_name },
    sessions: data.map(s => ({
      id:           s.id,
      issued_at:    s.issued_at,
      last_seen_at: s.last_seen_at,
      expires_at:   s.expires_at,
      revoked_at:   s.revoked_at,
      is_active:    !s.revoked_at && new Date(s.expires_at) > now
    }))
  });
});

// DELETE /api/v1/sessions/:sessionId — revoca sessione (PRIVATO)
// Usa case: operaio perde il telefono → admin revoca subito la sessione.
router.delete('/sessions/:sessionId', verifySupabaseJwt, async (req, res) => {
  const { sessionId } = req.params;

  // Verifica ownership (company_id nel record — no cross-company)
  const { data: session, error: sErr } = await supabase
    .from('worker_device_sessions')
    .select('id, worker_id, revoked_at')
    .eq('id', sessionId)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (sErr) return res.status(500).json({ error: 'DB_ERROR' });
  if (!session) return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
  if (session.revoked_at) {
    return res.status(409).json({ error: 'SESSION_ALREADY_REVOKED', revoked_at: session.revoked_at });
  }

  const revokedAt = new Date().toISOString();
  const { error: upErr } = await supabase
    .from('worker_device_sessions')
    .update({ revoked_at: revokedAt })
    .eq('id', sessionId)
    .eq('company_id', req.companyId);

  if (upErr) return res.status(500).json({ error: 'DB_ERROR' });

  // Audit
  auditLog({
    companyId:  req.companyId,
    userId:     req.user?.id,
    userRole:   req.userRole,
    action:     'session.revoke',
    targetType: 'session',
    targetId:   sessionId,
    payload:    { worker_id: session.worker_id },
    req
  });

  res.json({ ok: true, revoked_at: revokedAt });
});

module.exports = router;
