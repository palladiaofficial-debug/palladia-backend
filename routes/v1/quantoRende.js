'use strict';
/**
 * routes/v1/quantoRende.js — F-509 (AUDIT.md del frontend).
 * GET /quanto-rende?mese=YYYY-MM → costo della manodopera per cantiere,
 * ricavato da prospetto contabile, buste paga e timbrature (lib/quantoRende.js).
 * Sono paghe: solo titolare e amministratori.
 */
const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const logger = require('../../lib/logger');
const { quantoRendeMese } = require('../../lib/quantoRende');

router.get('/quanto-rende', verifySupabaseJwt, async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'SOLO_UFFICIO', message: 'Lo vedono solo il titolare e gli amministratori.' });
  }
  const mese = String(req.query.mese || '');
  try {
    res.json(await quantoRendeMese(req.companyId, mese));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: 'MESE_NON_VALIDO', message: err.message });
    logger.error({ err, companyId: req.companyId }, '[quanto-rende] errore');
    res.status(500).json({ error: 'ERRORE', message: 'Non riesco a fare il conto. Riprova.' });
  }
});

module.exports = router;
