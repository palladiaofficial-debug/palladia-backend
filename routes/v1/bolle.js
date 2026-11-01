'use strict';
// ── Le bolle del cantiere (F-422, AUDIT.md del frontend) ─────────────────────
//   GET /api/v1/cantieri/:siteId/bolle   → le bolle del cantiere, dalla più recente, con i materiali
//   GET /api/v1/bolle/:id/file           → { url } firmato per 10 minuti (la foto o il PDF)
// Le bolle si caricano da «Carica un documento» (lib/impreseCarica). Logica in lib/bolle.js.
const router = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const B = require('../../lib/bolle');
const logger = require('../../lib/logger');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fallito = (res, err, what) => {
  if (err instanceof B.BolleError) return res.status(err.status).json({ error: err.code });
  logger.error({ err }, `bolle: ${what}`);
  res.status(500).json({ error: 'DB_ERROR' });
};

router.get('/cantieri/:siteId/bolle', verifySupabaseJwt, async (req, res) => {
  if (!UUID.test(req.params.siteId)) return res.status(404).json({ error: 'NOT_FOUND' });
  try { res.json(await B.elenco(req.companyId, req.params.siteId)); } catch (err) { fallito(res, err, 'elenco'); }
});
router.get('/bolle/:id/file', verifySupabaseJwt, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  try { res.json(await B.file(req.companyId, req.params.id)); } catch (err) { fallito(res, err, 'file'); }
});

module.exports = router;
