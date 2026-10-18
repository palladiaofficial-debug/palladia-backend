'use strict';
// ── Imprese semplici (F-376, AUDIT.md del frontend) ──────────────────────────
// Titolare (JWT):
//   GET  /api/v1/imprese/panoramica          → prima cosa, una riga per impresa
//   GET  /api/v1/imprese/:id/scheda          → può lavorare? documenti, cantieri, operai, conti
//   POST /api/v1/imprese                     → { nome, piva } oppure { telefono } (+ siteId)
//   POST /api/v1/imprese/leggi               → foto alla visura / DURC → nome, P.IVA, sede (non salva)
//   POST /api/v1/imprese/:id/chiedi          → link + messaggio WhatsApp/email ({ rifare: docId })
//   POST /api/v1/imprese/:id/inviato         → «Manda su WhatsApp» toccato
//   POST /api/v1/imprese/:id/visti           → ho guardato quello che ha mandato
//   POST /api/v1/imprese/:id/cantieri        → { siteId }
//   POST /api/v1/imprese/:id/carica          → { tipo, siteId? } + file: carica il titolare, stesso controllo
//   POST /api/v1/imprese/doc/:docId/va-bene  → decide il titolare, sopra al controllo
// Impresa (link, senza registrazione):
//   GET  /api/v1/impresa-link/:token                       → le sue richieste e i suoi operai
//   POST /api/v1/impresa-link/:token/carica                → { tipo, siteId? } + file → controllato subito
//   POST /api/v1/impresa-link/:token/dati                  → i suoi dati
//   POST /api/v1/impresa-link/:token/operai                → { nome }
//   POST /api/v1/impresa-link/:token/operai/:id/carica     → { tipo: idoneita|formazione } + file
//   GET  /api/v1/impresa-link/:token/dichiarazione.pdf     → il modulo già compilato
// La logica sta in lib/imprese.js, lib/impreseLink.js, lib/impreseControllo.js.
const router = require('express').Router();
const multer = require('multer');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { aiLimiter, impresaLinkLimiter, impresaCaricaLimiter } = require('../../middleware/rateLimit');
const I = require('../../lib/imprese');
const L = require('../../lib/impreseLink');
const { dichiarazionePdf } = require('../../lib/impreseDichiarazione');
const { isFeatureEnabled } = require('../../lib/featureFlags');
const logger = require('../../lib/logger');

const WRITE_ROLES = ['owner', 'admin', 'tech'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scrive = (req, res, next) => (req.userRole && !WRITE_ROLES.includes(req.userRole) ? res.status(403).json({ error: 'FORBIDDEN' }) : next());
const idValido = (k) => (req, res, next) => (UUID.test(req.params[k]) ? next() : res.status(404).json({ error: 'NOT_FOUND' }));
const modulo = async (req, res, next) => ((await isFeatureEnabled(req.companyId, 'subappaltatori').catch(() => false)) ? next() : res.status(404).json({ error: 'NOT_FOUND' }));
const fallito = (res, err, what) => {
  if (err instanceof I.ImpreseError || err instanceof L.LinkError) return res.status(err.status).json({ error: err.code, ...(err.id ? { id: err.id } : {}) });
  logger.error({ err }, `imprese: ${what}`);
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

// ── Titolare ─────────────────────────────────────────────────────────────────
const auth = [verifySupabaseJwt, modulo];

router.get('/imprese/panoramica', ...auth, async (req, res) => {
  try { res.json(await I.panoramica(req.companyId)); } catch (err) { fallito(res, err, 'panoramica'); }
});
router.get('/imprese/:id/scheda', ...auth, idValido('id'), async (req, res) => {
  try { res.json(await I.scheda(req.companyId, req.params.id)); } catch (err) { fallito(res, err, 'scheda'); }
});
router.post('/imprese', ...auth, scrive, async (req, res) => {
  try { res.status(201).json(await I.crea(req.companyId, req.body || {})); } catch (err) { fallito(res, err, 'crea'); }
});
router.post('/imprese/leggi', ...auth, scrive, aiLimiter, unFile, async (req, res) => {
  try { res.json(await I.leggiPerAggiungere(req.companyId, req.file)); }
  catch (err) { logger.error({ err }, 'imprese: leggi'); res.status(502).json({ error: 'LETTURA_NON_RIUSCITA' }); }
});
router.post('/imprese/:id/chiedi', ...auth, scrive, idValido('id'), async (req, res) => {
  const rifare = req.body?.rifare && UUID.test(req.body.rifare) ? req.body.rifare : null;
  try { res.json(await I.chiedi(req.companyId, req.user?.id, req.params.id, { rifare })); } catch (err) { fallito(res, err, 'chiedi'); }
});
router.post('/imprese/:id/inviato', ...auth, scrive, idValido('id'), async (req, res) => {
  try { await I.inviato(req.companyId, req.params.id); res.json({ ok: true }); } catch (err) { fallito(res, err, 'inviato'); }
});
router.post('/imprese/:id/visti', ...auth, scrive, idValido('id'), async (req, res) => {
  try { await I.visti(req.companyId, req.params.id); res.json({ ok: true }); } catch (err) { fallito(res, err, 'visti'); }
});
router.post('/imprese/:id/cantieri', ...auth, scrive, idValido('id'), async (req, res) => {
  if (!UUID.test(String(req.body?.siteId || ''))) return res.status(400).json({ error: 'SITE_NOT_FOUND' });
  try { await I.mettiInCantiere(req.companyId, req.params.id, req.body.siteId); res.json({ ok: true }); } catch (err) { fallito(res, err, 'cantieri'); }
});
router.post('/imprese/:id/carica', ...auth, scrive, aiLimiter, idValido('id'), unFile, async (req, res) => {
  const siteId = req.body?.siteId && UUID.test(req.body.siteId) ? req.body.siteId : null;
  try { res.status(201).json(await L.caricaDalTitolare(req.companyId, req.user?.id, req.params.id, { tipo: req.body?.tipo, siteId, file: req.file })); } catch (err) { fallito(res, err, 'carica titolare'); }
});
router.post('/imprese/doc/:docId/va-bene', ...auth, scrive, idValido('docId'), async (req, res) => {
  try { await I.vaBene(req.companyId, req.params.docId); res.json({ ok: true }); } catch (err) { fallito(res, err, 'va bene'); }
});

// ── Impresa: il link ─────────────────────────────────────────────────────────
router.get('/impresa-link/:token', impresaLinkLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await L.datiPubblici(req.params.token)); } catch (err) { fallito(res, err, 'link dati'); }
});
router.post('/impresa-link/:token/carica', impresaLinkLimiter, impresaCaricaLimiter, unFile, async (req, res) => {
  const siteId = req.body?.siteId && UUID.test(req.body.siteId) ? req.body.siteId : null;
  try { res.status(201).json(await L.caricaDaImpresa(req.params.token, { tipo: req.body?.tipo, siteId, file: req.file })); } catch (err) { fallito(res, err, 'link carica'); }
});
router.post('/impresa-link/:token/dati', impresaLinkLimiter, async (req, res) => {
  try { await L.salvaDati(req.params.token, req.body || {}); res.json({ ok: true }); } catch (err) { fallito(res, err, 'link dati impresa'); }
});
router.post('/impresa-link/:token/operai', impresaLinkLimiter, async (req, res) => {
  try { res.status(201).json(await L.aggiungiOperaio(req.params.token, req.body || {})); } catch (err) { fallito(res, err, 'link operaio'); }
});
router.post('/impresa-link/:token/operai/:id/carica', impresaLinkLimiter, impresaCaricaLimiter, idValido('id'), unFile, async (req, res) => {
  try { res.status(201).json(await L.caricaOperaio(req.params.token, req.params.id, { tipo: req.body?.tipo, file: req.file })); } catch (err) { fallito(res, err, 'link operaio carica'); }
});
router.get('/impresa-link/:token/dichiarazione.pdf', impresaLinkLimiter, async (req, res) => {
  try {
    const { link, impresa, azienda } = await L.daToken(req.params.token);
    const cantieri = await L.cantieriImpresa(link.company_id, impresa.id);
    const pdf = await dichiarazionePdf({
      impresa: { nome: impresa.da_completare ? null : impresa.company_name, piva: impresa.piva, indirizzo: impresa.legal_address, referente: impresa.contact_person },
      azienda: azienda.name, cantieri,
    });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="dichiarazione-art14.pdf"', 'Cache-Control': 'no-store' });
    res.send(pdf);
  } catch (err) { fallito(res, err, 'dichiarazione'); }
});

module.exports = router;
