'use strict';
// ── Carica documenti delle imprese, tutti in un colpo (F-401, AUDIT.md del frontend) ──
//   POST  /api/v1/imprese/caricamenti                     → { subcontractorId? } → { id }
//   POST  /api/v1/imprese/caricamenti/:id/file            → un file (PDF, foto, ZIP)
//   GET   /api/v1/imprese/caricamenti/:id                 → avanzamento + tutto in ordine
//   GET   /api/v1/imprese/caricamenti/:id/doc/:docId      → link per guardarlo
//   PATCH /api/v1/imprese/caricamenti/:id/doc/:docId      → correggere (tipo, impresa, operaio, cantiere, scadenza, scartato)
//   POST  /api/v1/imprese/caricamenti/:id/salva           → nelle schede delle imprese
// Stessa porta di Imprese (modulo «subappaltatori») e stessi ruoli che scrivono.
// La logica sta in lib/impreseCarica/.
const router = require('express').Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { isFeatureEnabled } = require('../../lib/featureFlags');
const { auditLog } = require('../../lib/audit');
const K = require('../../lib/impreseCarica');
const logger = require('../../lib/logger');

const WRITE_ROLES = ['owner', 'admin', 'tech'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scrive = (req, res, next) => (req.userRole && !WRITE_ROLES.includes(req.userRole) ? res.status(403).json({ error: 'FORBIDDEN' }) : next());
const idValidi = (req, res, next) => (UUID.test(req.params.id) && (!req.params.docId || UUID.test(req.params.docId)) ? next() : res.status(404).json({ error: 'NOT_FOUND' }));
const modulo = async (req, res, next) => ((await isFeatureEnabled(req.companyId, 'subappaltatori').catch(() => false)) ? next() : res.status(404).json({ error: 'NOT_FOUND' }));
const fallito = (res, err, what) => {
  if (err instanceof K.CaricaError) return res.status(err.status).json({ error: err.code });
  logger.error({ err }, `imprese carica: ${what}`);
  res.status(500).json({ error: 'DB_ERROR' });
};
// Un caricamento può avere decine di file: il limite AI generico (10 al minuto) li bloccherebbe
const perAzienda = (max, windowMs) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false, validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => `imprese-carica:${req.companyId || req.ip}`,
  handler: (_req, res) => res.status(429).json({ error: 'TROPPI' }),
});
const limiteFile = perAzienda(150, 60 * 1000);
const limiteCaricamenti = perAzienda(30, 60 * 60 * 1000);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
const unFile = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
  if (err) return res.status(400).json({ error: err.message });
  if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });
  next();
});
const auth = [verifySupabaseJwt, modulo, scrive];

router.post('/imprese/caricamenti', ...auth, limiteCaricamenti, async (req, res) => {
  const sub = req.body?.subcontractorId;
  if (sub && !UUID.test(sub)) return res.status(400).json({ error: 'IMPRESA_NON_VALIDA' });
  try { res.status(201).json(await K.crea(req.companyId, req.user?.id, { subcontractorId: sub || null })); } catch (err) { fallito(res, err, 'crea'); }
});
router.post('/imprese/caricamenti/:id/file', ...auth, limiteFile, idValidi, unFile, async (req, res) => {
  try { res.status(201).json(await K.aggiungi(req.companyId, req.params.id, req.file)); } catch (err) { fallito(res, err, 'file'); }
});
router.get('/imprese/caricamenti/:id', ...auth, idValidi, async (req, res) => {
  try { res.json(await K.stato(req.companyId, req.params.id)); } catch (err) { fallito(res, err, 'stato'); }
});
router.get('/imprese/caricamenti/:id/doc/:docId', ...auth, idValidi, async (req, res) => {
  try { res.json(await K.apri(req.companyId, req.params.id, req.params.docId)); } catch (err) { fallito(res, err, 'apri'); }
});
router.patch('/imprese/caricamenti/:id/doc/:docId', ...auth, idValidi, async (req, res) => {
  try { res.json(await K.correggi(req.companyId, req.params.id, req.params.docId, req.body || {})); } catch (err) { fallito(res, err, 'correggi'); }
});
router.post('/imprese/caricamenti/:id/salva', ...auth, idValidi, async (req, res) => {
  try {
    const r = await K.salva(req.companyId, req.user?.id, req.params.id);
    auditLog({ companyId: req.companyId, userId: req.user?.id, userRole: req.userRole, action: 'imprese.carica_tutto', targetType: 'imprese_caricamento', targetId: req.params.id, payload: { salvati: r.salvati, impreseNuove: r.impreseNuove, operaiNuovi: r.operaiNuovi }, req });
    res.json(r);
  } catch (err) { fallito(res, err, 'salva'); }
});

module.exports = router;
