'use strict';
// F-500 (AUDIT.md del frontend): «Fotografa la bolla» dal badge dell'autista.
// Stessa identità del badge (nessun login), solo per chi è abilitato ai DDT
// (workers.ddt_upload_enabled, lo stesso interruttore di prima).
//   GET  /api/v1/badge/:code/bolle   → nome, cantiere di oggi, cantieri, bolle mandate oggi
//   POST /api/v1/badge/:code/bolle   → multipart: pagine (1–6 foto o PDF), site_id?, client_id?
// La pagina dell'autista è public/bolla-autista.html su /timbratura/:code/bolla.
// Logica in lib/bolleAutisti.js. Le timbrature non si toccano.
const router = require('express').Router();
const multer = require('multer');
const { resolveWorkerByBadge } = require('../../lib/workerByBadge');
const { badgePunchLimiter, aiLimiter } = require('../../middleware/rateLimit');
const BA = require('../../lib/bolleAutisti');
const logger = require('../../lib/logger');

const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: BA.MAX_PAGINE },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'].includes(file.mimetype)),
});
const conPagine = (req, res, next) => upload.array('pagine', BA.MAX_PAGINE)(req, res, (err) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'TROPPE_PAGINE' : err.message });
  if (err) return res.status(400).json({ error: err.message });
  next();
});

async function autista(req, res) {
  const w = await resolveWorkerByBadge(req.params.code);
  if (!w) { res.status(401).json({ error: 'BADGE_NOT_FOUND' }); return null; }
  if (!w.is_active) { res.status(403).json({ error: 'BADGE_REVOKED' }); return null; }
  if (!w.ddt_upload_enabled) { res.status(403).json({ error: 'DDT_NOT_ENABLED' }); return null; }
  return w;
}
const fallito = (res, err, what) => {
  if (err instanceof BA.BolleAutistiError) return res.status(err.status).json({ error: err.code });
  logger.error({ err }, `bolle autisti: ${what}`);
  res.status(500).json({ error: 'DB_ERROR' });
};

router.get('/badge/:code/bolle', badgePunchLimiter, async (req, res) => {
  const w = await autista(req, res); if (!w) return;
  try { res.json(await BA.info(w)); } catch (err) { fallito(res, err, 'info'); }
});
router.post('/badge/:code/bolle', badgePunchLimiter, aiLimiter, conPagine, async (req, res) => {
  const w = await autista(req, res); if (!w) return;
  try { res.status(201).json(await BA.manda(w, { files: req.files, siteId: req.body?.site_id || null, clientId: req.body?.client_id || null })); }
  catch (err) { fallito(res, err, 'manda'); }
});

//   POST /api/v1/badge/:code/bolle/:id/cantiere → { site_id } (solo se non si è capito)
router.post('/badge/:code/bolle/:id/cantiere', badgePunchLimiter, async (req, res) => {
  const w = await autista(req, res); if (!w) return;
  try { res.json(await BA.scegliCantiere(w, req.params.id, req.body?.site_id)); } catch (err) { fallito(res, err, 'cantiere'); }
});

module.exports = router;
