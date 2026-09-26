'use strict';
// ── GET /api/v1/da-fare — la lista unica della porta "Da fare" (F-236) ────────
// Tutta la logica sta in lib/daFare.js. Risponde:
//   { today, items: [...], counts: { scaduto, settimana, mese, in_corso }, attention }
// `attention` (scaduto + settimana) è il numero sulla campanella.
const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { buildDaFare } = require('../../lib/daFare');
const logger = require('../../lib/logger');

router.get('/da-fare', verifySupabaseJwt, async (req, res) => {
  try {
    const result = await buildDaFare(req.companyId, req.user?.id || null);
    res.json(result);
  } catch (err) {
    logger.error({ err, companyId: req.companyId }, 'da-fare: errore di costruzione della lista');
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

module.exports = router;
