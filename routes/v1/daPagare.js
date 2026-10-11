'use strict';
// ── Da pagare (F-338, AUDIT.md del frontend) ──────────────────────────────────
// GET    /api/v1/da-pagare                      → { righe, totaleSettimana, pagatiQuestoMese, email }
// POST   /api/v1/da-pagare                      multipart { fornitore, importo, entro, sollecitato?, numeroFattura?, file? }
// POST   /api/v1/da-pagare/leggi                multipart { file } → { fornitore, importo, scadenza, numero, certa } (non salva)
// PATCH  /api/v1/da-pagare/:id                  { fornitore?, importo?, entro?, sollecitato? }
// POST   /api/v1/da-pagare/:id/pagato · /non-pagato · /conferma
// POST   /api/v1/da-pagare/:id/rimanda          { giorni } | { al }
// POST   /api/v1/da-pagare/:id/annulla-rimanda  { sollecitato? }
// DELETE /api/v1/da-pagare/:id
// GET    /api/v1/da-pagare/:id/foto             → { url } firmato 10 min
// POST   /api/v1/da-pagare/email/attiva         → indirizzo per inoltrare le fatture
// GET    /api/v1/da-pagare/email/contatto.vcf   → contatto "Da pagare · azienda" da salvare
// Solo titolare, amministratori e tecnici; dietro il flag `da_pagare`.
const router = require('express').Router();
const multer = require('multer');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { aiLimiter } = require('../../middleware/rateLimit');
const { auditLog } = require('../../lib/audit');
const { checkAiBudget } = require('../../lib/ladiaUsageLog');
const logger = require('../../lib/logger');
const supabase = require('../../lib/supabase');
const P = require('../../lib/daPagare');
const { leggiFattura } = require('../../lib/daPagareLettura');
const { connectCompany, getStatus } = require('../../services/emailIngestConfig');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIPI = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/xml', 'text/xml', 'application/pkcs7-mime', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = TIPI.includes(file.mimetype) || /\.(xml|p7m|zip|pdf|jpe?g|png|webp)$/i.test(file.originalname || '');
    cb(ok ? null : Object.assign(new Error('Formato non accettato: foto, PDF o XML della fattura'), { code: 'FORMATO', status: 400 }), ok);
  },
});
function conFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'FILE_TROPPO_GRANDE', message: 'Il file è troppo grande (massimo 15 MB)' });
    return res.status(err.status || 400).json({ error: err.code || 'FILE', message: err.message });
  });
}

async function guard(req, res) {
  if (!(await P.attivoPer(req.companyId))) { res.status(404).json({ error: 'FEATURE_DISABLED' }); return false; }
  if (!P.puoVedere(req.userRole)) { res.status(403).json({ error: 'FORBIDDEN', message: 'Da pagare è visibile solo al titolare e ai tecnici.' }); return false; }
  return true;
}
function fallito(res, err, dove) {
  if (err.code && err.status) return res.status(err.status).json({ error: err.code, message: err.message });
  logger.error({ err }, dove);
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
}
const audit = (req, action, targetId, payload) => auditLog({
  companyId: req.companyId, userId: req.user?.id || null, userRole: req.userRole || null,
  action, targetType: 'da_pagare', targetId, payload, req,
});
const idOk = (req, res) => { if (UUID.test(req.params.id)) return true; res.status(404).json({ error: 'NOT_FOUND' }); return false; };
const vero = (v) => v === true || v === 'true' || v === '1' || v === 'on';

router.get('/da-pagare', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const [elenco, email] = await Promise.all([P.elenco(req.companyId), getStatus(req.companyId).catch(() => null)]);
    res.json({ ...elenco, ruolo: req.userRole || null, email: email && email.status === 'active' ? { indirizzo: email.address } : null });
  } catch (err) { fallito(res, err, 'da-pagare GET'); }
});

router.post('/da-pagare/leggi', verifySupabaseJwt, aiLimiter, conFile, async (req, res) => {
  if (!(await guard(req, res))) return;
  if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED', message: 'Scegli la foto, il PDF o l\'XML della fattura' });
  try {
    const xml = /\.(xml|p7m|zip)$/i.test(req.file.originalname || '');
    if (!xml) {
      const budget = await checkAiBudget(req.companyId);
      if (!budget.allowed) return res.status(429).json({ error: 'AI_BUDGET_EXCEEDED', message: 'Lettura automatica non disponibile ora: scrivi i dati a mano.' });
    }
    const r = await leggiFattura({ buffer: req.file.buffer, mimetype: req.file.mimetype, originalname: req.file.originalname, companyId: req.companyId });
    if (!r) return res.status(422).json({ error: 'NON_LEGGIBILE', message: 'Non riesco a leggere la fattura: scrivi i dati a mano, la foto resta allegata.' });
    res.json(r);
  } catch (err) { fallito(res, err, 'da-pagare leggi'); }
});

router.post('/da-pagare', verifySupabaseJwt, conFile, async (req, res) => {
  if (!(await guard(req, res))) return;
  const b = req.body || {};
  try {
    const r = await P.crea({
      companyId: req.companyId, userId: req.user?.id, fornitore: b.fornitore, importo: b.importo, entro: b.entro,
      sollecitato: vero(b.sollecitato), numeroFattura: b.numeroFattura || null, file: req.file || null,
    });
    audit(req, 'da_pagare.crea', r.id, { importo: r.importo, entro: r.scadenza, conFoto: !!req.file });
    res.status(201).json(r);
  } catch (err) { fallito(res, err, 'da-pagare POST'); }
});

router.post('/da-pagare/email/attiva', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  // Come POST /expenses/email-ingest/connect: l'indirizzo lo crea il titolare (o un amministratore)
  if (req.userRole && !['owner', 'admin'].includes(req.userRole)) return res.status(403).json({ error: 'FORBIDDEN', message: 'L\'indirizzo per le fatture lo attiva il titolare.' });
  try {
    const r = await connectCompany(req.companyId, req.user?.id);
    audit(req, 'da_pagare.email_attiva', null, {});
    res.json({ indirizzo: r.address });
  } catch (err) { fallito(res, err, 'da-pagare email attiva'); }
});

router.get('/da-pagare/email/contatto.vcf', verifySupabaseJwt, async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const st = await getStatus(req.companyId);
    if (!st || st.status !== 'active') return res.status(404).json({ error: 'EMAIL_NON_ATTIVA' });
    const { data: company } = await supabase.from('companies').select('name').eq('id', req.companyId).maybeSingle();
    const nome = `Da pagare · ${String(company?.name || 'Palladia').replace(/[\r\n;,]/g, ' ')}`;
    const vcf = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${nome}`, `N:${nome};;;;`, `EMAIL;TYPE=INTERNET:${st.address}`, 'NOTE:Inoltra qui le fatture da pagare. Palladia ti risponde con quello che ha letto.', 'END:VCARD', ''].join('\r\n');
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="da-pagare.vcf"');
    res.send(vcf);
  } catch (err) { fallito(res, err, 'da-pagare vcf'); }
});

router.patch('/da-pagare/:id', verifySupabaseJwt, async (req, res) => {
  if (!idOk(req, res) || !(await guard(req, res))) return;
  const { fornitore, importo, entro, sollecitato } = req.body || {};
  try {
    const r = await P.aggiorna({ companyId: req.companyId, id: req.params.id, fornitore, importo, entro, sollecitato });
    audit(req, 'da_pagare.modifica', r.id, { fornitore: fornitore !== undefined, importo, entro, sollecitato });
    res.json(r);
  } catch (err) { fallito(res, err, 'da-pagare PATCH'); }
});

const azione = (nome, fn, auditName) => router.post(`/da-pagare/:id/${nome}`, verifySupabaseJwt, async (req, res) => {
  if (!idOk(req, res) || !(await guard(req, res))) return;
  try {
    const r = await fn({ companyId: req.companyId, id: req.params.id, ...(req.body || {}) });
    audit(req, auditName, req.params.id, req.body || {});
    res.json(r);
  } catch (err) { fallito(res, err, `da-pagare ${nome}`); }
});
azione('pagato', P.pagato, 'da_pagare.pagato');
azione('non-pagato', P.nonPagato, 'da_pagare.non_pagato');
azione('conferma', P.conferma, 'da_pagare.conferma');
azione('rimanda', ({ companyId, id, giorni, al }) => P.rimanda({ companyId, id, giorni, al }), 'da_pagare.rimanda');
azione('annulla-rimanda', ({ companyId, id, sollecitato }) => P.annullaRimanda({ companyId, id, sollecitato }), 'da_pagare.annulla_rimanda');

router.delete('/da-pagare/:id', verifySupabaseJwt, async (req, res) => {
  if (!idOk(req, res) || !(await guard(req, res))) return;
  try {
    const r = await P.elimina({ companyId: req.companyId, id: req.params.id });
    audit(req, 'da_pagare.elimina', req.params.id, {});
    res.json(r);
  } catch (err) { fallito(res, err, 'da-pagare DELETE'); }
});

router.get('/da-pagare/:id/foto', verifySupabaseJwt, async (req, res) => {
  if (!idOk(req, res) || !(await guard(req, res))) return;
  try { res.json(await P.fotoFirmata({ companyId: req.companyId, id: req.params.id })); }
  catch (err) { fallito(res, err, 'da-pagare foto'); }
});

module.exports = router;
