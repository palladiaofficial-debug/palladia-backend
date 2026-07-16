'use strict';
/**
 * routes/v1/sdiConsultation.js
 * Consultazione fatture elettroniche via Delega Unificata (vedi services/sdiConsultation.js)
 * — meccanismo di sola lettura, complementare a routes/v1/sdiInvoices.js (che invece
 * sposta il Codice Destinatario). Nessun webhook pubblico: la lettura è periodica
 * (cron), non un evento push.
 *
 * POST /api/v1/expenses/sdi/consultation/connect      — collega la company (JWT, owner/admin)
 * GET  /api/v1/expenses/sdi/consultation/status        — stato della delega (JWT)
 * POST /api/v1/expenses/sdi/consultation/disconnect    — disattiva il polling lato Palladia (JWT, owner/admin)
 */

const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const { connectSdiConsultationSchema } = require('../../lib/schemas/sdiConsultation');
const { connectCompany, getStatus, disconnectCompany } = require('../../services/sdiConsultation');

function isAdminOrOwner(role) {
  return role === 'owner' || role === 'admin';
}

router.post('/expenses/sdi/consultation/connect', verifySupabaseJwt, validate(connectSdiConsultationSchema), async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Solo owner e admin possono attivare la consultazione fatture.' });
  }
  try {
    const result = await connectCompany({
      companyId:           req.companyId,
      userId:              req.user.id,
      fiscalId:            req.body.fiscal_id,
      fisconlineUsername:  req.body.fisconline_username,
      fisconlinePassword:  req.body.fisconline_password,
      fisconlinePin:       req.body.fisconline_pin,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('[sdi-consultation] connect error:', err.message);
    res.status(502).json({ error: 'SDI_CONSULTATION_CONNECT_ERROR', message: err.message });
  }
});

router.get('/expenses/sdi/consultation/status', verifySupabaseJwt, async (req, res) => {
  try {
    const status = await getStatus(req.companyId);
    res.json(status || { status: 'not_connected' });
  } catch (err) {
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

router.post('/expenses/sdi/consultation/disconnect', verifySupabaseJwt, async (req, res) => {
  if (!isAdminOrOwner(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  try {
    await disconnectCompany(req.companyId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

module.exports = router;
