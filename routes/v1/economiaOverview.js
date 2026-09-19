'use strict';
/**
 * routes/v1/economiaOverview.js
 *
 * F-215 (AUDIT.md): endpoint per la pagina "Economia" unificata. Vedi
 * services/economiaOverview.js per il ragionamento su cosa significano
 * da_incassare/da_pagare e perché non riusa il registro Controllo Economico.
 */

const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { buildSiteEconomiaOverview, buildCompanyEconomiaOverview } = require('../../services/economiaOverview');

router.use(['/economia-overview', '/sites/:siteId/economia-overview'], verifySupabaseJwt);

router.get('/economia-overview', async (req, res) => {
  try {
    const data = await buildCompanyEconomiaOverview(req.companyId);
    res.json(data);
  } catch (err) {
    console.error('[economia-overview] error:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'DB_ERROR' });
  }
});

router.get('/sites/:siteId/economia-overview', async (req, res) => {
  try {
    const data = await buildSiteEconomiaOverview(req.params.siteId, req.companyId);
    res.json(data);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[economia-overview] site error:', err.message);
    res.status(500).json({ error: 'DB_ERROR' });
  }
});

module.exports = router;
