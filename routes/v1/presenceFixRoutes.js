'use strict';
// ── Timbrature da sistemare (mockup "Timbrature senza errori", 2026-10-03) ────
// Da fare mostra i casi aperti (lib/daFare.js) con la proposta già pronta; qui
// il titolare la conferma con un tocco, sceglie un altro orario o chiude il
// caso ("È giusta"). Solo titolare e amministratori, come la Correzione manuale.
const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { applyFixRequest, dismissFixRequest } = require('../../lib/presenceFix');

const UUID_RE = /^[0-9a-f-]{36}$/i;
const STATUS = { NOT_FOUND: 404, ALREADY_DONE: 409, STATE_CHANGED: 409, NOT_APPLICABLE: 400, NO_SITE: 400, INVALID_TIME: 400, DB_ERROR: 500 };

function ownerAdmin(req, res) {
  if (['owner', 'admin'].includes(req.userRole)) return true;
  res.status(403).json({ error: 'FORBIDDEN', required_role: ['owner', 'admin'] });
  return false;
}

// POST /api/v1/presence/fix-requests/:id/apply { at?: "HH:MM" }
router.post('/presence/fix-requests/:id/apply', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const r = await applyFixRequest({ id: req.params.id, companyId: req.companyId, userId: req.user.id, userRole: req.userRole, at: req.body?.at ?? null });
  if (!r.ok) return res.status(STATUS[r.code] || 400).json({ error: r.code, message: r.message });
  res.json({ ok: true, written: r.written });
});

// POST /api/v1/presence/fix-requests/:id/dismiss — "È giusta": si chiude senza scrivere niente
router.post('/presence/fix-requests/:id/dismiss', verifySupabaseJwt, async (req, res) => {
  if (!ownerAdmin(req, res)) return;
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  const r = await dismissFixRequest({ id: req.params.id, companyId: req.companyId, userId: req.user.id });
  if (!r.ok) return res.status(STATUS[r.code] || 400).json({ error: r.code, message: r.message });
  res.json({ ok: true });
});

module.exports = router;
