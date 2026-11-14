'use strict';
// F-497 (AUDIT.md del frontend): Subappaltatori, lavori e pagamenti.
// Solo titolare e amministratori: i soldi dei sub non li vedono tecnici e viewer.
// La logica sta in lib/subPagamenti.js.
const router = require('express').Router();
const multer = require('multer');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { auditLog } = require('../../lib/audit');
const S = require('../../lib/subPagamenti');
const logger = require('../../lib/logger');

const ufficio = (req, res, next) => (['owner', 'admin'].includes(req.userRole) ? next() : res.status(403).json({ error: 'FORBIDDEN', message: 'I pagamenti ai subappaltatori li vedono solo il titolare e gli amministratori.' }));
const acceso = async (req, res, next) => ((await S.attivo(req.companyId)) ? next() : res.status(404).json({ error: 'NON_ATTIVO' }));
const auth = [verifySupabaseJwt, ufficio, acceso];

const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^(application\/pdf|image\/(jpeg|png|webp|heic))$/.test(file.mimetype)),
});
const unFile = (campo) => (req, res, next) => upload.single(campo)(req, res, (err) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
  if (err) return res.status(400).json({ error: err.message });
  next();
});
const fallito = (res, err, what) => {
  if (err instanceof S.SubError) return res.status(err.status).json({ error: err.code, message: err.message !== err.code ? err.message : undefined, id: err.id });
  logger.error({ err }, `subappalti: ${what}`);
  res.status(500).json({ error: 'DB_ERROR' });
};
const traccia = (req, action, targetId, payload) => auditLog({ companyId: req.companyId, userId: req.user?.id, userRole: req.userRole, action, targetType: 'sub_accordo', targetId, payload, req }).catch(() => {});

router.get('/subappalti', ...auth, async (req, res) => {
  try { res.json(await S.elenco(req.companyId)); } catch (err) { fallito(res, err, 'elenco'); }
});
router.get('/subappalti/opzioni', ...auth, async (req, res) => {
  try { res.json(await S.opzioni(req.companyId)); } catch (err) { fallito(res, err, 'opzioni'); }
});
router.get('/subappalti/impresa/:subId', ...auth, async (req, res) => {
  try { res.json(await S.impresa(req.companyId, req.params.subId)); } catch (err) { fallito(res, err, 'impresa'); }
});
router.post('/subappalti', ...auth, async (req, res) => {
  try {
    const r = await S.crea(req.companyId, req.user?.id, req.body || {});
    traccia(req, 'subappalti.accordo', r.id, { tipo: req.body?.tipo });
    res.status(201).json(r);
  } catch (err) { fallito(res, err, 'crea'); }
});
router.get('/subappalti/:id', ...auth, async (req, res) => {
  try { res.json(await S.conto(req.companyId, req.params.id, req.query.mese)); } catch (err) { fallito(res, err, 'conto'); }
});
router.patch('/subappalti/:id', ...auth, async (req, res) => {
  try {
    const r = await S.modifica(req.companyId, req.params.id, req.body || {});
    traccia(req, 'subappalti.accordo_modifica', req.params.id, req.body);
    res.json(r);
  } catch (err) { fallito(res, err, 'modifica'); }
});
router.post('/subappalti/:id/contratto', ...auth, unFile('file'), async (req, res) => {
  try { res.json(await S.contratto(req.companyId, req.params.id, req.file)); } catch (err) { fallito(res, err, 'contratto'); }
});
router.post('/subappalti/:id/pagamenti', ...auth, unFile('prova'), async (req, res) => {
  try {
    const r = await S.pagamento(req.companyId, req.user?.id, req.params.id, req.body || {}, req.file);
    traccia(req, 'subappalti.pagamento', req.params.id, { importo: r.importo, modo: r.modo, data: r.data });
    res.status(201).json(r);
  } catch (err) { fallito(res, err, 'pagamento'); }
});
router.delete('/subappalti/:id/pagamenti/:pid', ...auth, async (req, res) => {
  try {
    const r = await S.togliPagamento(req.companyId, req.params.id, req.params.pid);
    traccia(req, 'subappalti.pagamento_tolto', req.params.id, { pagamento: req.params.pid });
    res.json(r);
  } catch (err) { fallito(res, err, 'togli pagamento'); }
});
router.put('/subappalti/:id/giorni/:giorno', ...auth, async (req, res) => {
  try { res.json(await S.giorno(req.companyId, req.user?.id, req.params.id, req.params.giorno, req.body?.giornate === undefined ? null : req.body.giornate)); } catch (err) { fallito(res, err, 'giorno'); }
});
router.post('/subappalti/:id/lavoro', ...auth, unFile('foto'), async (req, res) => {
  try { res.json(await S.lavoro(req.companyId, req.user?.id, req.params.id, req.body?.quarti, req.file)); } catch (err) { fallito(res, err, 'lavoro'); }
});
router.post('/subappalti/:id/lavori', ...auth, async (req, res) => {
  try { res.status(201).json(await S.aggiungiLavoro(req.companyId, req.params.id, req.body?.nome)); } catch (err) { fallito(res, err, 'aggiungi lavoro'); }
});
router.patch('/subappalti/:id/lavori/:lid', ...auth, async (req, res) => {
  try { res.json(await S.aggiornaLavoro(req.companyId, req.params.id, req.params.lid, req.body || {})); } catch (err) { fallito(res, err, 'aggiorna lavoro'); }
});
router.delete('/subappalti/:id/lavori/:lid', ...auth, async (req, res) => {
  try { res.json(await S.togliLavoro(req.companyId, req.params.id, req.params.lid)); } catch (err) { fallito(res, err, 'togli lavoro'); }
});

module.exports = router;
