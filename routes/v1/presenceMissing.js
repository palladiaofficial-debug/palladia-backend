'use strict';
// GET /api/v1/presence/missing-today — chi non ha timbrato oggi (F-285).
// Sola lettura. Stesso accesso dello storico presenze (GET /presence/history).
const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { missingToday } = require('../../lib/presenceMissing');

router.get('/presence/missing-today', verifySupabaseJwt, async (req, res) => {
  try {
    res.json(await missingToday(req.companyId));
  } catch (err) {
    console.error('[presence/missing-today]', err.message);
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

module.exports = router;
