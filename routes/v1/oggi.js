'use strict';
// ── GET /api/v1/oggi — la home di Palladia semplice (F-364) ─────────────────
// Tutta la logica sta in lib/oggi.js. Sola lettura, dietro il flag home_semplice.
const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { isFeatureEnabled } = require('../../lib/featureFlags');
const { costruisci } = require('../../lib/oggi');
const logger = require('../../lib/logger');

router.get('/oggi', verifySupabaseJwt, async (req, res) => {
  try {
    if (!(await isFeatureEnabled(req.companyId, 'home_semplice'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
    res.json(await costruisci(req.companyId, req.user?.id || null, req.userRole || null));
  } catch (err) {
    logger.error({ err, companyId: req.companyId }, 'oggi: home non costruita');
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
