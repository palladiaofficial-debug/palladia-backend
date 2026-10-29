'use strict';
// ── Carica le buste del mese (F-399, AUDIT.md del frontend) ─────────────────
//   POST /api/v1/buste/carica                      → file PDF: lo divide, non manda niente
//   GET  /api/v1/buste/carica/:id/esistenti?anno&mese → chi ha già la busta di quel mese
//   POST /api/v1/buste/carica/:id/conferma         → { anno, mese, assegna }: le manda
// Solo titolare e amministratori. La logica sta in lib/bustePaga/.
const router = require('express').Router();
const multer = require('multer');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { auditLog } = require('../../lib/audit');
const B = require('../../lib/bustePaga');
const logger = require('../../lib/logger');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const titolare = (req, res, next) => (['owner', 'admin'].includes(req.userRole) ? next() : res.status(403).json({ error: 'FORBIDDEN' }));
const idValido = (req, res, next) => (UUID.test(req.params.id) ? next() : res.status(404).json({ error: 'NOT_FOUND' }));
const fallito = (res, err, what) => {
  if (err instanceof B.BusteError) return res.status(err.status).json({ error: err.code });
  logger.error({ err }, `buste: ${what}`);
  res.status(500).json({ error: 'DB_ERROR' });
};
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
});
const unPdf = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
  if (err) return res.status(400).json({ error: err.message });
  if (!req.file) return res.status(400).json({ error: 'SOLO_PDF' });
  next();
});
const auth = [verifySupabaseJwt, titolare];

router.post('/buste/carica', ...auth, unPdf, async (req, res) => {
  try { res.status(201).json(await B.leggi(req.companyId, req.user?.id, req.file)); } catch (err) { fallito(res, err, 'leggi'); }
});
router.get('/buste/carica/:id/esistenti', ...auth, idValido, async (req, res) => {
  const anno = Number(req.query.anno), mese = Number(req.query.mese);
  if (!Number.isInteger(anno) || !Number.isInteger(mese)) return res.status(400).json({ error: 'MESE_NON_VALIDO' });
  try { res.json(await B.esistentiPer(req.companyId, req.params.id, { anno, mese })); } catch (err) { fallito(res, err, 'esistenti'); }
});
router.post('/buste/carica/:id/conferma', ...auth, idValido, async (req, res) => {
  const { anno, mese, assegna } = req.body || {};
  try {
    const r = await B.conferma(req.companyId, req.user?.id, req.params.id, { anno, mese, assegna: assegna && typeof assegna === 'object' ? assegna : {} });
    auditLog({ companyId: req.companyId, userId: req.user?.id, userRole: req.userRole, action: 'buste.manda', targetType: 'buste_caricamento', targetId: req.params.id, payload: { anno, mese, mandate: r.mandate }, req });
    res.json(r);
  } catch (err) { fallito(res, err, 'conferma'); }
});

module.exports = router;
