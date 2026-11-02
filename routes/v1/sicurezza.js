'use strict';
// ── La sicurezza dei cantieri (F-424, AUDIT.md del frontend) ─────────────────
//   GET /api/v1/sicurezza/cantieri          → tutti i cantieri aperti: PSC, il tuo POS, imprese, operai, cosa manca
//   GET /api/v1/sicurezza/cantieri/:siteId  → la catena di un cantiere e chi ha letto il POS
//   GET /api/v1/sicurezza/cantieri/:siteId/psc → F-426: il PSC letto e confrontato con il tuo POS
//                                               (la prima volta risponde «in_lettura»: si ripassa)
// Logica in lib/sicurezzaCantieri.js.
const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const S = require('../../lib/sicurezzaCantieri');
const P = require('../../lib/pscLetto');
const logger = require('../../lib/logger');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fallito = (res, err, what) => {
  if (err instanceof S.SicurezzaError || err instanceof P.PscError) return res.status(err.status).json({ error: err.code });
  logger.error({ err }, `sicurezza: ${what}`);
  res.status(500).json({ error: 'DB_ERROR' });
};

router.get('/sicurezza/cantieri', verifySupabaseJwt, async (req, res) => {
  try { res.json(await S.elenco(req.companyId)); } catch (err) { fallito(res, err, 'elenco'); }
});
router.get('/sicurezza/cantieri/:siteId', verifySupabaseJwt, async (req, res) => {
  if (!UUID.test(req.params.siteId)) return res.status(404).json({ error: 'NOT_FOUND' });
  try { res.json(await S.cantiere(req.companyId, req.params.siteId)); } catch (err) { fallito(res, err, 'cantiere'); }
});

router.get('/sicurezza/cantieri/:siteId/psc', verifySupabaseJwt, async (req, res) => {
  if (!UUID.test(req.params.siteId)) return res.status(404).json({ error: 'NOT_FOUND' });
  try {
    const out = await P.scheda(req.companyId, req.params.siteId);
    delete out.dati;
    res.json(out);
  } catch (err) { fallito(res, err, 'psc'); }
});
// Per il POS rapido: la lettura completa (committente, coordinatori, fasi, richieste)
router.get('/sicurezza/cantieri/:siteId/psc/dati', verifySupabaseJwt, async (req, res) => {
  if (!UUID.test(req.params.siteId)) return res.status(404).json({ error: 'NOT_FOUND' });
  try {
    const out = await P.scheda(req.companyId, req.params.siteId);
    res.json({ stato: out.stato, dati: out.stato === 'letto' ? { ...out.dati, documentId: out.doc.id, fileName: out.doc.nome } : null });
  } catch (err) { fallito(res, err, 'psc dati'); }
});

module.exports = router;
