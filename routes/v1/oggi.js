'use strict';
// ── GET /api/v1/oggi — la home di Palladia semplice (F-364) ─────────────────
// Tutta la logica sta in lib/oggi.js. Sola lettura, dietro il flag home_semplice (o menu_semplice, F-365).
const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { isFeatureEnabled } = require('../../lib/featureFlags');
const { costruisci } = require('../../lib/oggi');
const altriPosti = require('../../lib/altriPosti');
const logger = require('../../lib/logger');

router.get('/oggi', verifySupabaseJwt, async (req, res) => {
  try {
    // Anche il menu a 4 voci (F-365) legge da qui il numerino di «Oggi»
    const [home, menu] = await Promise.all([isFeatureEnabled(req.companyId, 'home_semplice'), isFeatureEnabled(req.companyId, 'menu_semplice')]);
    if (!home && !menu) return res.status(404).json({ error: 'FEATURE_DISABLED' });
    res.json(await costruisci(req.companyId, req.user?.id || null, req.userRole || null));
  } catch (err) {
    logger.error({ err, companyId: req.companyId }, 'oggi: home non costruita');
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ── GET /api/v1/cantieri/altri-posti — F-371: i numeri delle righe Documenti
// e POS in fondo a Cantieri. Sola lettura, dietro il flag menu_semplice.
router.get('/cantieri/altri-posti', verifySupabaseJwt, async (req, res) => {
  try {
    if (!await isFeatureEnabled(req.companyId, 'menu_semplice')) return res.status(404).json({ error: 'FEATURE_DISABLED' });
    res.json(await altriPosti.costruisci(req.companyId, req.user?.id || null, req.userRole || null));
  } catch (err) {
    logger.error({ err, companyId: req.companyId }, 'altri-posti: numeri non calcolati');
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
