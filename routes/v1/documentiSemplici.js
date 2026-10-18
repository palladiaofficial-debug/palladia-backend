'use strict';
// ── Documenti senza cartelle (F-316, AUDIT.md) ───────────────────────────────
// GET  /api/v1/documenti/riepilogo            → le cinque voci con lo stato
// GET  /api/v1/documenti/elenco/:kind         → chi ha problemi prima
// GET  /api/v1/documenti/scheda/:kind/:id     → cosa serve e cosa c'è
// POST /api/v1/documenti/carica               → file + scadenza confermata
// PATCH /api/v1/documenti/doc/:docId           → correggi la scadenza (F-329)
// GET  /api/v1/documenti/panoramica           → F-374: la pagina in una richiesta
// POST /api/v1/documenti/leggi                → F-374: cos'è, di chi è, quando scade (non salva)
// La logica sta in lib/documentiStato.js e lib/documentiCarica.js.
const router = require('express').Router();
const multer = require('multer');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { riepilogo, elenco, scheda, panoramica } = require('../../lib/documentiStato');
const { leggi } = require('../../lib/documentiLeggi');
const { aiLimiter } = require('../../middleware/rateLimit');
const { carica, CaricaError } = require('../../lib/documentiCarica');
const { correggi, CorreggiError } = require('../../lib/documentiCorreggi');
const logger = require('../../lib/logger');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const WRITE_ROLES = ['owner', 'admin', 'tech'];

const fail = (res, err, what) => {
  logger.error({ err }, `documenti: ${what}`);
  res.status(500).json({ error: 'DB_ERROR' });
};

router.get('/documenti/riepilogo', verifySupabaseJwt, async (req, res) => {
  try { res.json({ sezioni: await riepilogo(req.companyId) }); } catch (err) { fail(res, err, 'riepilogo'); }
});

router.get('/documenti/panoramica', verifySupabaseJwt, async (req, res) => {
  try { res.json(await panoramica(req.companyId)); } catch (err) { fail(res, err, 'panoramica'); }
});

const uploadLettura = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)),
});
router.post('/documenti/leggi', verifySupabaseJwt, aiLimiter,
  (req, res, next) => uploadLettura.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    if (req.userRole && !WRITE_ROLES.includes(req.userRole)) return res.status(403).json({ error: 'FORBIDDEN' });
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED', message: 'Serve un PDF o una foto (JPG, PNG)' });
    try {
      res.json(await leggi({ companyId: req.companyId, userId: req.user?.id || null, file: req.file }));
    } catch (err) {
      logger.error({ err }, 'documenti: leggi');
      res.status(502).json({ error: 'LETTURA_NON_RIUSCITA', message: 'Non riesco a leggere il foglio. Scegli tu di chi è e la data.' });
    }
  });

router.get('/documenti/elenco/:kind', verifySupabaseJwt, async (req, res) => {
  try {
    const list = await elenco(req.companyId, req.params.kind);
    if (!list) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ kind: req.params.kind, elenco: list });
  } catch (err) { fail(res, err, 'elenco'); }
});

router.get('/documenti/scheda/:kind/:id', verifySupabaseJwt, async (req, res) => {
  try {
    const s = await scheda(req.companyId, req.params.kind, req.params.id);
    if (!s) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(s);
  } catch (err) { fail(res, err, 'scheda'); }
});

router.post('/documenti/carica', verifySupabaseJwt,
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    if (req.userRole && !WRITE_ROLES.includes(req.userRole)) return res.status(403).json({ error: 'FORBIDDEN' });
    const { kind, id, requisito, scadenza, nome } = req.body || {};
    try {
      const out = await carica({
        companyId: req.companyId, userId: req.user?.id || null, userRole: req.userRole || null,
        kind, id, reqKey: requisito || null, expiry: scadenza || null, label: nome || null,
        file: req.file, req,
      });
      res.status(201).json(out);
    } catch (err) {
      if (err instanceof CaricaError) return res.status(err.status).json({ error: err.code, message: err.message });
      fail(res, err, 'carica');
    }
  });

// F-329: un documento in regola si deve poter correggere (data letta male,
// "È giusta, salva" premuto per sbaglio). L'eliminazione usa le rotte che
// esistono già: la scheda dà il percorso `elimina` di ogni documento.
router.patch('/documenti/doc/:docId', verifySupabaseJwt, async (req, res) => {
  if (req.userRole && !WRITE_ROLES.includes(req.userRole)) return res.status(403).json({ error: 'FORBIDDEN' });
  const { scadenza } = req.body || {};
  try {
    res.json(await correggi({
      companyId: req.companyId, docId: req.params.docId, scadenza: scadenza || null,
      userId: req.user?.id || null, userRole: req.userRole || null, req,
    }));
  } catch (err) {
    if (err instanceof CorreggiError) return res.status(err.status).json({ error: err.code, message: err.message });
    fail(res, err, 'correggi');
  }
});

module.exports = router;
