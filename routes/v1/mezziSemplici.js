'use strict';
// ── Mezzi semplici (F-375, AUDIT.md del frontend) ────────────────────────────
// GET    /api/v1/mezzi/panoramica              → prima cosa, una riga per mezzo
// GET    /api/v1/mezzi/:id/scheda              → scadenze, promemoria, dov'è, documenti
// POST   /api/v1/mezzi/libretto                → legge il libretto (non salva)
// POST   /api/v1/mezzi                         → crea dal libretto confermato o un'attrezzatura
// PATCH  /api/v1/mezzi/:id                     → immatricolazione, massa, revisione, targa
// PUT    /api/v1/mezzi/:id/dove                → { siteId | null }
// POST   /api/v1/mezzi/:id/promemoria          → { tipo, testo?, scadenza }
// DELETE /api/v1/mezzi/:id/promemoria/:pid
// POST   /api/v1/mezzi/:id/togli               → «Non lo usiamo più» (recuperabile)
// La logica sta in lib/mezzi.js, lib/mezziLibretto.js, lib/mezziRevisione.js.
const router = require('express').Router();
const multer = require('multer');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { aiLimiter } = require('../../middleware/rateLimit');
const M = require('../../lib/mezzi');
const { leggiLibretto } = require('../../lib/mezziLibretto');
const logger = require('../../lib/logger');

const WRITE_ROLES = ['owner', 'admin', 'tech'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const scrive = (req, res, next) => (req.userRole && !WRITE_ROLES.includes(req.userRole) ? res.status(403).json({ error: 'FORBIDDEN' }) : next());
const idValido = (req, res, next) => (UUID.test(req.params.id) ? next() : res.status(404).json({ error: 'NOT_FOUND' }));
const fallito = (res, err, what) => {
  if (err instanceof M.MezziError) return res.status(err.status).json({ error: err.code, ...(err.id ? { id: err.id } : {}) });
  logger.error({ err }, `mezzi: ${what}`);
  res.status(500).json({ error: 'DB_ERROR' });
};

router.get('/mezzi/panoramica', verifySupabaseJwt, async (req, res) => {
  try { res.json(await M.panoramica(req.companyId)); } catch (err) { fallito(res, err, 'panoramica'); }
});

router.get('/mezzi/:id/scheda', verifySupabaseJwt, idValido, async (req, res) => {
  try {
    const s = await M.scheda(req.companyId, req.params.id);
    if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(s);
  } catch (err) { fallito(res, err, 'scheda'); }
});

const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)),
});
router.post('/mezzi/libretto', verifySupabaseJwt, scrive, aiLimiter,
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED', message: 'Serve un PDF o una foto (JPG, PNG)' });
    try {
      res.json(await leggiLibretto({ companyId: req.companyId, userId: req.user?.id || null, file: req.file }));
    } catch (err) {
      logger.error({ err }, 'mezzi: libretto');
      res.status(502).json({ error: 'LETTURA_NON_RIUSCITA', message: 'Non riesco a leggere il libretto. Scrivi tu i dati.' });
    }
  });

router.post('/mezzi', verifySupabaseJwt, scrive, async (req, res) => {
  try { res.status(201).json(await M.crea(req.companyId, req.user?.id, req.body || {})); } catch (err) { fallito(res, err, 'crea'); }
});

router.patch('/mezzi/:id', verifySupabaseJwt, scrive, idValido, async (req, res) => {
  try { await M.aggiorna(req.companyId, req.params.id, req.body || {}); res.json({ ok: true }); } catch (err) { fallito(res, err, 'aggiorna'); }
});

router.put('/mezzi/:id/dove', verifySupabaseJwt, scrive, idValido, async (req, res) => {
  const siteId = req.body?.siteId || null;
  if (siteId && !UUID.test(siteId)) return res.status(400).json({ error: 'SITE_NOT_FOUND' });
  try { await M.mettiIn(req.companyId, req.params.id, siteId); res.json({ ok: true }); } catch (err) { fallito(res, err, 'dove'); }
});

router.post('/mezzi/:id/promemoria', verifySupabaseJwt, scrive, idValido, async (req, res) => {
  try { res.status(201).json(await M.aggiungiPromemoria(req.companyId, req.user?.id, req.params.id, req.body || {})); } catch (err) { fallito(res, err, 'promemoria'); }
});

router.delete('/mezzi/:id/promemoria/:pid', verifySupabaseJwt, scrive, idValido, async (req, res) => {
  if (req.params.pid !== 'tagliando-vecchio' && !UUID.test(req.params.pid)) return res.status(404).json({ error: 'NOT_FOUND' });
  try { await M.togliPromemoria(req.companyId, req.params.id, req.params.pid); res.json({ ok: true }); } catch (err) { fallito(res, err, 'togli promemoria'); }
});

router.post('/mezzi/:id/togli', verifySupabaseJwt, scrive, idValido, async (req, res) => {
  try { await M.togli(req.companyId, req.params.id); res.json({ ok: true }); } catch (err) { fallito(res, err, 'togli'); }
});

module.exports = router;
