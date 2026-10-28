'use strict';
// ── Contratto di subappalto (F-398, AUDIT.md del frontend) ──────────────────
//   GET  /api/v1/imprese/:id/contratto            → dati già noti, cantieri, clausole, contratti fatti
//   POST /api/v1/imprese/:id/contratto/visura     → file: legge la visura e la archivia
//   POST /api/v1/imprese/:id/contratto            → genera il PDF, lo archivia, ResultCard
//   GET  /api/v1/contratti/:cid/pdf               → link per scaricarlo
// Stessa porta di Imprese (modulo «subappaltatori») e stessi ruoli che scrivono.
// La logica sta in lib/contratti/.
const router = require('express').Router();
const multer = require('multer');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { aiLimiter } = require('../../middleware/rateLimit');
const { isFeatureEnabled } = require('../../lib/featureFlags');
const { auditLog } = require('../../lib/audit');
const K = require('../../lib/contratti');
const logger = require('../../lib/logger');

const WRITE_ROLES = ['owner', 'admin', 'tech'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scrive = (req, res, next) => (req.userRole && !WRITE_ROLES.includes(req.userRole) ? res.status(403).json({ error: 'FORBIDDEN' }) : next());
const idValido = (k) => (req, res, next) => (UUID.test(req.params[k]) ? next() : res.status(404).json({ error: 'NOT_FOUND' }));
const modulo = async (req, res, next) => ((await isFeatureEnabled(req.companyId, 'subappaltatori').catch(() => false)) ? next() : res.status(404).json({ error: 'NOT_FOUND' }));
const fallito = (res, err, what) => {
  if (err instanceof K.ContrattoError) return res.status(err.status).json({ error: err.code, ...(err.campi ? { campi: err.campi } : {}) });
  logger.error({ err }, `contratti: ${what}`);
  res.status(500).json({ error: 'DB_ERROR' });
};
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)),
});
const unFile = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
  if (err) return res.status(400).json({ error: err.message });
  if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });
  next();
});
const auth = [verifySupabaseJwt, modulo, scrive];

router.get('/imprese/:id/contratto', ...auth, idValido('id'), async (req, res) => {
  try { res.json(await K.prepara(req.companyId, req.params.id)); } catch (err) { fallito(res, err, 'prepara'); }
});
router.post('/imprese/:id/contratto/visura', ...auth, aiLimiter, idValido('id'), unFile, async (req, res) => {
  try { res.json(await K.visura(req.companyId, req.user?.id, req.params.id, req.file)); } catch (err) { fallito(res, err, 'visura'); }
});
router.post('/imprese/:id/contratto', ...auth, idValido('id'), async (req, res) => {
  try {
    const r = await K.genera(req.companyId, req.user?.id, req.params.id, req.body || {});
    auditLog({ companyId: req.companyId, userId: req.user?.id, userRole: req.userRole, action: 'contratto.genera', targetType: 'subcontractor', targetId: req.params.id, payload: { contratto_id: r.id }, req });
    res.status(201).json(r);
  } catch (err) { fallito(res, err, 'genera'); }
});
router.get('/contratti/:cid/pdf', ...auth, idValido('cid'), async (req, res) => {
  try { res.json(await K.scarica(req.companyId, req.params.cid)); } catch (err) { fallito(res, err, 'scarica'); }
});

module.exports = router;
