'use strict';
/**
 * routes/v1/estrattoConto.js — F-513 (AUDIT.md del frontend).
 * L'estratto conto della banca segna le fatture di Da pagare pagate davvero.
 * Solo titolare e amministratori, solo con il flag estratto_conto acceso.
 *
 *   POST /estratto-conto            file (Excel/CSV) → movimenti salvati + proposte
 *   GET  /estratto-conto/proposte   le proposte ancora aperte
 *   POST /estratto-conto/conferma   { movimentoId, fatture: [id] }
 *   POST /estratto-conto/scarta     { movimentoId }
 */
const router = require('express').Router();
const multer = require('multer');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { auditLog } = require('../../lib/audit');
const logger = require('../../lib/logger');
const { isFeatureEnabled } = require('../../lib/featureFlags');
const E = require('../../lib/estrattoConto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls|csv|txt|pdf)$/i.test(file.originalname || '');
    cb(ok ? null : Object.assign(new Error('Carica il file dei movimenti: Excel o CSV.'), { code: 'FORMATO', status: 400 }), ok);
  },
});

async function guardia(req, res, next) {
  if (!['owner', 'admin'].includes(req.userRole)) return res.status(403).json({ error: 'SOLO_UFFICIO', message: 'Lo vedono solo il titolare e gli amministratori.' });
  if (!(await isFeatureEnabled(req.companyId, 'estratto_conto'))) return res.status(404).json({ error: 'FEATURE_DISABLED' });
  next();
}
const sbaglio = (res, err, cosa) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.code || 'NON_VALIDO', message: err.message });
  logger.error({ err }, `[estratto-conto] ${cosa}`);
  return res.status(500).json({ error: 'ERRORE', message: 'Non sono riuscito a leggerlo. Riprova.' });
};
const audit = (req, action, targetId, payload) => auditLog({ companyId: req.companyId, userId: req.user?.id || null, userRole: req.userRole, action, targetType: 'estratto_conto', targetId, payload, req }).catch(() => {});

router.post('/estratto-conto', verifySupabaseJwt, guardia, (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'FILE_TROPPO_GRANDE', message: 'Il file è troppo grande (massimo 10 MB).' });
  return res.status(err.status || 400).json({ error: err.code || 'FILE', message: err.message });
}), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'FILE', message: 'Manca il file.' });
  try {
    const r = await E.carica({ companyId: req.companyId, userId: req.user?.id, buffer: req.file.buffer, nomeFile: req.file.originalname, mime: req.file.mimetype });
    audit(req, 'estratto_conto.caricato', null, { movimenti: r.letti.movimenti, nuovi: r.letti.nuovi });
    res.json(r);
  } catch (err) { sbaglio(res, err, 'carica'); }
});

router.get('/estratto-conto/proposte', verifySupabaseJwt, guardia, async (req, res) => {
  try { res.json(await E.proposte(req.companyId)); } catch (err) { sbaglio(res, err, 'proposte'); }
});

router.post('/estratto-conto/conferma', verifySupabaseJwt, guardia, async (req, res) => {
  const { movimentoId, fatture } = req.body || {};
  if (!UUID.test(String(movimentoId)) || !Array.isArray(fatture) || !fatture.every(id => UUID.test(String(id)))) {
    return res.status(400).json({ error: 'NON_VALIDO', message: 'Movimento o fatture non validi.' });
  }
  try {
    const r = await E.conferma(req.companyId, movimentoId, fatture);
    audit(req, 'estratto_conto.conferma', movimentoId, { fatture });
    res.json(r);
  } catch (err) { sbaglio(res, err, 'conferma'); }
});

router.post('/estratto-conto/scarta', verifySupabaseJwt, guardia, async (req, res) => {
  const { movimentoId } = req.body || {};
  if (!UUID.test(String(movimentoId))) return res.status(400).json({ error: 'NON_VALIDO', message: 'Movimento non valido.' });
  try {
    const r = await E.scarta(req.companyId, movimentoId);
    audit(req, 'estratto_conto.scarta', movimentoId, {});
    res.json(r);
  } catch (err) { sbaglio(res, err, 'scarta'); }
});

module.exports = router;
