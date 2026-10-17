'use strict';
// ── Conti dei sub (F-360, AUDIT.md del frontend) ─────────────────────────────
// GET    /api/v1/conti-sub                     → { daControllare, approvati, storico }
// GET    /api/v1/conti-sub/opzioni             → { imprese, cantieri }
// POST   /api/v1/conti-sub                     multipart { file } → legge il foglio e crea il conto
// GET    /api/v1/conti-sub/:id                 → il conto con le differenze
// PATCH  /api/v1/conti-sub/:id                 { subcontractorId?, siteId?, mese? } → rifà i controlli
// POST   /api/v1/conti-sub/:id/decidi          { riga: id|'tariffa', decisione: 'foglio'|'proposta', valore? }
// POST   /api/v1/conti-sub/:id/contratto       { riga, quantita } → quantità del contratto per una voce
// POST   /api/v1/conti-sub/:id/approva · /riapri
// DELETE /api/v1/conti-sub/:id
// GET    /api/v1/conti-sub/:id/pdf · /excel · /foglio
// Solo titolare, amministratori e tecnici; dietro il flag `conti_sub`.
const router = require('express').Router();
const multer = require('multer');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { aiLimiter } = require('../../middleware/rateLimit');
const { auditLog } = require('../../lib/audit');
const { checkAiBudget } = require('../../lib/ladiaUsageLog');
const logger = require('../../lib/logger');
const S = require('../../lib/contiSub');
const { leggiFoglio, tipoFoglio } = require('../../lib/contiSubLettura');
const { pdfConto, excelConto } = require('../../lib/contiSubDocumenti');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const t = tipoFoglio(file.originalname, file.mimetype);
    cb(t ? null : Object.assign(new Error('Carica il foglio in Excel (.xlsx), PDF o foto.'), { code: 'FORMATO', status: 400 }), !!t);
  },
});
function conFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'FILE_TROPPO_GRANDE', message: 'Il file è troppo grande (massimo 20 MB)' });
    return res.status(err.status || 400).json({ error: err.code || 'FILE', message: err.message });
  });
}

async function guard(req, res) {
  if (!(await S.attivoPer(req.companyId))) { res.status(404).json({ error: 'FEATURE_DISABLED' }); return false; }
  if (!S.puoVedere(req.userRole)) { res.status(403).json({ error: 'FORBIDDEN', message: 'I conti dei sub sono visibili solo al titolare e ai tecnici.' }); return false; }
  return true;
}
function fallito(res, err, dove) {
  if (err.code && err.status) return res.status(err.status).json({ error: err.code, message: err.message });
  logger.error({ err }, dove);
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
}
const audit = (req, action, targetId, payload) => auditLog({
  companyId: req.companyId, userId: req.user?.id || null, userRole: req.userRole || null,
  action, targetType: 'conto_sub', targetId, payload, req,
});
const nomeUtente = (req) => req.user?.user_metadata?.full_name || req.user?.user_metadata?.name || req.user?.email || null;
const nomeFile = (d, ext) => `Conto ${d.impresa.nome} ${d.meseTesto}.${ext}`.replace(/[\\/:*?"<>|]+/g, '-');

router.get('/conti-sub', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  try { res.json(await S.elenco(req.companyId)); } catch (err) { fallito(res, err, 'conti-sub GET'); }
});

router.get('/conti-sub/opzioni', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  try { res.json(await S.opzioni(req.companyId)); } catch (err) { fallito(res, err, 'conti-sub opzioni'); }
});

router.post('/conti-sub', verifySupabaseJwt, aiLimiter, conFile, async (req, res) => {
  if (!(await guard(req, res))) return;
  if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED', message: 'Scegli il foglio del sub' });
  try {
    const budget = await checkAiBudget(req.companyId);
    if (!budget.allowed) return res.status(429).json({ error: 'AI_BUDGET_EXCEEDED', message: 'Lettura automatica non disponibile ora. Riprova più tardi.' });
    const lettura = await leggiFoglio({ buffer: req.file.buffer, mimetype: req.file.mimetype, originalname: req.file.originalname, companyId: req.companyId });
    if (!lettura) return res.status(422).json({ error: 'NON_LEGGIBILE', message: 'Non riesco a leggere ore o lavori in questo file. È il conto del sub?' });
    const d = await S.crea({ companyId: req.companyId, userId: req.user?.id, lettura, file: req.file });
    audit(req, 'conto_sub.crea', d.id, { impresa: d.impresa.nome, mese: d.mese, righe: d.ore.length + d.misura.length });
    res.status(201).json(d);
  } catch (err) { fallito(res, err, 'conti-sub POST'); }
});

router.get('/conti-sub/:id', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  try { res.json(await S.dettaglio(req.companyId, req.params.id)); } catch (err) { fallito(res, err, 'conti-sub dettaglio'); }
});

router.patch('/conti-sub/:id', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  const b = req.body || {};
  try {
    const d = await S.correggi({ companyId: req.companyId, id: req.params.id, subcontractorId: b.subcontractorId, siteId: b.siteId, mese: b.mese });
    audit(req, 'conto_sub.correggi', d.id, { subcontractorId: b.subcontractorId, siteId: b.siteId, mese: b.mese });
    res.json(d);
  } catch (err) { fallito(res, err, 'conti-sub PATCH'); }
});

router.post('/conti-sub/:id/decidi', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  const b = req.body || {};
  try { res.json(await S.decidi({ companyId: req.companyId, id: req.params.id, rigaId: b.riga, decisione: b.decisione, valore: b.valore })); }
  catch (err) { fallito(res, err, 'conti-sub decidi'); }
});

router.post('/conti-sub/:id/contratto', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  const b = req.body || {};
  try { res.json(await S.contratto({ companyId: req.companyId, id: req.params.id, rigaId: b.riga, quantita: b.quantita })); }
  catch (err) { fallito(res, err, 'conti-sub contratto'); }
});

router.post('/conti-sub/:id/approva', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const d = await S.approva({ companyId: req.companyId, id: req.params.id, userId: req.user?.id, nome: nomeUtente(req) });
    audit(req, 'conto_sub.approva', d.id, { totale: d.approvato?.totale, impresa: d.impresa.nome, mese: d.mese });
    res.json(d);
  } catch (err) { fallito(res, err, 'conti-sub approva'); }
});

router.post('/conti-sub/:id/riapri', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const d = await S.riapri({ companyId: req.companyId, id: req.params.id });
    audit(req, 'conto_sub.riapri', d.id, {});
    res.json(d);
  } catch (err) { fallito(res, err, 'conti-sub riapri'); }
});

router.delete('/conti-sub/:id', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const r = await S.elimina({ companyId: req.companyId, id: req.params.id });
    audit(req, 'conto_sub.elimina', req.params.id, {});
    res.json(r);
  } catch (err) { fallito(res, err, 'conti-sub DELETE'); }
});

router.get('/conti-sub/:id/pdf', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const d = await S.dettaglio(req.companyId, req.params.id);
    const buf = await pdfConto(req.companyId, d);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition'); // il nome del file arriva alla pagina
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nomeFile(d, 'pdf'))}`);
    res.send(buf);
  } catch (err) { fallito(res, err, 'conti-sub pdf'); }
});

router.get('/conti-sub/:id/excel', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const d = await S.dettaglio(req.companyId, req.params.id);
    const buf = await excelConto(req.companyId, d);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nomeFile(d, 'xlsx'))}`);
    res.send(buf);
  } catch (err) { fallito(res, err, 'conti-sub excel'); }
});

router.get('/conti-sub/:id/foglio', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  try { res.json(await S.fileFirmato({ companyId: req.companyId, id: req.params.id })); }
  catch (err) { fallito(res, err, 'conti-sub foglio'); }
});

module.exports = router;
