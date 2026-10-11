'use strict';
// ── Presenze delle imprese subappaltatrici (F-337, AUDIT.md del frontend) ─────
// Pubbliche, col QR firmato del cantiere (public/ingresso.html):
//   GET  /sub-scan/context?site&t&exp           → cantiere + imprese tra cui scegliere
//   POST /sub-scan/read-card   { site,t,exp, image }                → nome e codice fiscale dalla foto
//   POST /sub-scan/register    { site,t,exp, impresa, full_name, fiscal_code } → gettone del telefono
//   POST /sub-scan/ignota      { site,t,exp, impresa_nome, full_name, fiscal_code } → "La mia impresa non c'è"
//   GET  /sub-scan/stato?site&t&exp   (X-Sub-Token)            → nome, impresa, dentro?
//   POST /sub-scan/punch       { site,t,exp, event, client_request_id, gps } (X-Sub-Token)
// Pubbliche, col link della squadra (public/squadra.html):
//   GET  /squadra/:token/dati · POST /squadra/:token/segna · /persone · /tutti-fuori
// Ufficio (JWT):
//   GET  /sites/:siteId/imprese-oggi
//   POST|DELETE /sites/:siteId/subcontractors/:subId/link-squadra
//   GET|POST /sites/:siteId/subcontractors/:subId/persone
//   POST /sites/:siteId/sub-presenze { sub_worker_id, event }
//   POST /sub-presenze/:id/annulla · POST /sub-impresa-ignota/:id/chiudi { come, subcontractor_id }
//   GET  /sites/:siteId/cartello-ingresso       → PDF A4 con il QR che dura fino alla fine del cantiere
// La logica è in lib/subPresenze.js. Dietro il flag `presenze_imprese`.
const router = require('express').Router();
const QRCode = require('qrcode');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { subScanLimiter, subCardLimiter, squadraLimiter } = require('../../middleware/rateLimit');
const { verifyQrToken, signQrToken } = require('./qr');
const { auditLog } = require('../../lib/audit');
const { checkAiBudget } = require('../../lib/ladiaUsageLog');
const logger = require('../../lib/logger');
const S = require('../../lib/subPresenze');
const { leggiTessera, TIPI_IMMAGINE } = require('../../lib/subTessera');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WRITE_ROLES = ['owner', 'admin', 'tech'];
const MAX_IMG_BYTES = 6 * 1024 * 1024;

function fallito(res, err, dove) {
  if (err.code && err.status) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err.code && err.code !== err.message && !/^\d/.test(err.code)) return res.status(400).json({ error: err.code, message: err.message });
  logger.error({ err }, dove);
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
}

/** QR firmato del cantiere (stesso controllo di /scan/identify). */
function qrValido(q) {
  const site = q?.site, t = q?.t, exp = Number(q?.exp);
  if (!site || !UUID.test(site) || !t || !Number.isFinite(exp) || exp <= 0) return { ok: false, error: 'MISSING_QR_SIGNATURE' };
  if (Date.now() / 1000 > exp) return { ok: false, error: 'QR_EXPIRED' };
  try { if (!verifyQrToken(site, t, exp)) return { ok: false, error: 'INVALID_QR_SIGNATURE' }; }
  catch { return { ok: false, error: 'SIGNING_NOT_CONFIGURED' }; }
  return { ok: true, site };
}
function conQr(fonte) {
  return (req, res, next) => {
    const v = qrValido(fonte === 'query' ? req.query : req.body);
    if (!v.ok) return res.status(401).json({ error: v.error, message: 'Inquadra il QR del cantiere' });
    req.siteId = v.site;
    next();
  };
}

// ── Pubbliche: QR ───────────────────────────────────────────────────────────
router.get('/sub-scan/context', subScanLimiter, conQr('query'), async (req, res) => {
  try {
    const { site, imprese, attivo } = await S.impreseDelCantiere(req.siteId);
    res.json({ cantiere: { nome: site.name, indirizzo: site.address || '' }, attivo, imprese, appBase: baseUrl() });
  } catch (err) { fallito(res, err, 'sub-scan context'); }
});

router.post('/sub-scan/read-card', subCardLimiter, conQr('body'), async (req, res) => {
  try {
    const site = await S.cantiere(req.siteId);
    if (!(await S.attivoPer(site.company_id))) return res.status(403).json({ error: 'MODULO_NON_ATTIVO' });
    const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.image || ''));
    if (!m || !TIPI_IMMAGINE.includes(m[1])) return res.status(400).json({ error: 'IMAGE_REQUIRED' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMG_BYTES) return res.status(413).json({ error: 'IMAGE_TOO_LARGE' });
    const budget = await checkAiBudget(site.company_id);
    if (!budget.allowed) return res.status(429).json({ error: 'AI_BUDGET_EXCEEDED' });
    const r = await leggiTessera(buf, m[1], { companyId: site.company_id });
    if (!r) return res.status(422).json({ error: 'NON_LEGGIBILE' });
    res.json(r);
  } catch (err) { fallito(res, err, 'sub-scan read-card'); }
});

router.post('/sub-scan/register', subScanLimiter, conQr('body'), async (req, res) => {
  const { impresa, full_name, fiscal_code } = req.body || {};
  if (!UUID.test(String(impresa || ''))) return res.status(400).json({ error: 'IMPRESA_REQUIRED' });
  try { res.json(await S.registraDaQr({ siteId: req.siteId, impresaId: impresa, fullName: full_name, fiscalCode: fiscal_code })); }
  catch (err) { fallito(res, err, 'sub-scan register'); }
});

router.post('/sub-scan/ignota', subScanLimiter, conQr('body'), async (req, res) => {
  const { impresa_nome, full_name, fiscal_code } = req.body || {};
  try { res.json(await S.registraImpresaIgnota({ siteId: req.siteId, impresaNome: impresa_nome, fullName: full_name, fiscalCode: fiscal_code })); }
  catch (err) { fallito(res, err, 'sub-scan ignota'); }
});

async function personaQui(req) {
  const persona = await S.personaDaGettone(req.get('X-Sub-Token'));
  const site = await S.cantiere(req.siteId);
  if (site.company_id !== persona.company_id) throw S.errore('DEVICE_TOKEN_INVALID', 'Telefono non riconosciuto', 401);
  if (!(await S.attivoPer(site.company_id))) throw S.errore('MODULO_NON_ATTIVO', 'Chiedi al capocantiere di segnarti', 403);
  return { persona, site };
}

router.get('/sub-scan/stato', subScanLimiter, conQr('query'), async (req, res) => {
  try {
    const { persona, site } = await personaQui(req);
    const supabase = require('../../lib/supabase');
    const [{ dentroSito, ultimo }, { data: sub }] = await Promise.all([
      S.statoDi(persona),
      supabase.from('subcontractors').select('company_name').eq('id', persona.subcontractor_id).maybeSingle(),
    ]);
    res.json({
      nome: persona.full_name, impresa: sub?.company_name || '',
      cantiere: { nome: site.name, indirizzo: site.address || '' },
      dentro: dentroSito === site.id, dentroAltrove: !!dentroSito && dentroSito !== site.id,
      ultimaOra: ultimo?.at || null,
    });
  } catch (err) { fallito(res, err, 'sub-scan stato'); }
});

router.post('/sub-scan/punch', subScanLimiter, conQr('body'), async (req, res) => {
  const { event, client_request_id, gps } = req.body || {};
  try {
    const { persona, site } = await personaQui(req);
    res.json(await S.segna({ subWorker: persona, site, event: event || null, source: 'qr', gps, clientRequestId: client_request_id }));
  } catch (err) { fallito(res, err, 'sub-scan punch'); }
});

// ── Pubbliche: link della squadra ───────────────────────────────────────────
router.get('/squadra/:token/dati', squadraLimiter, async (req, res) => {
  try { res.json(await S.squadra(req.params.token)); }
  catch (err) { fallito(res, err, 'squadra dati'); }
});
router.post('/squadra/:token/segna', squadraLimiter, async (req, res) => {
  const { sub_worker_id, event, client_request_id } = req.body || {};
  if (!UUID.test(String(sub_worker_id || ''))) return res.status(400).json({ error: 'SUB_WORKER_ID_REQUIRED' });
  try { res.json(await S.segnaDaSquadra(req.params.token, { subWorkerId: sub_worker_id, event, clientRequestId: client_request_id })); }
  catch (err) { fallito(res, err, 'squadra segna'); }
});
router.post('/squadra/:token/persone', squadraLimiter, async (req, res) => {
  try { res.json(await S.aggiungiDaSquadra(req.params.token, { fullName: req.body?.full_name })); }
  catch (err) { fallito(res, err, 'squadra persone'); }
});
router.post('/squadra/:token/tutti-fuori', squadraLimiter, async (req, res) => {
  try { res.json(await S.tuttiFuori(req.params.token)); }
  catch (err) { fallito(res, err, 'squadra tutti fuori'); }
});

// ── Ufficio ─────────────────────────────────────────────────────────────────
async function guard(req, res, scrive) {
  if (!(await S.attivoPer(req.companyId))) { res.status(404).json({ error: 'FEATURE_DISABLED' }); return false; }
  if (scrive && req.userRole && !WRITE_ROLES.includes(req.userRole)) { res.status(403).json({ error: 'FORBIDDEN', message: 'Solo il titolare, un amministratore o un tecnico può farlo.' }); return false; }
  return true;
}
const audit = (req, action, targetId, payload) => auditLog({
  companyId: req.companyId, userId: req.user?.id || null, userRole: req.userRole || null,
  action, targetType: 'sub_presenze', targetId, payload, req,
});
function idsOk(req, res, ...nomi) {
  for (const n of nomi) if (!UUID.test(String(req.params[n] || ''))) { res.status(404).json({ error: 'NOT_FOUND' }); return false; }
  return true;
}
const baseUrl = () => (process.env.APP_BASE_URL || '').replace(/\/$/, '');

router.get('/sites/:siteId/imprese-oggi', verifySupabaseJwt, async (req, res) => {
  if (!idsOk(req, res, 'siteId') || !(await guard(req, res, false))) return;
  try { res.json(await S.impreseOggi(req.companyId, req.params.siteId)); }
  catch (err) { fallito(res, err, 'imprese-oggi'); }
});

router.post('/sites/:siteId/subcontractors/:subId/link-squadra', verifySupabaseJwt, async (req, res) => {
  if (!idsOk(req, res, 'siteId', 'subId') || !(await guard(req, res, true))) return;
  try {
    const { token } = await S.creaLinkSquadra({ companyId: req.companyId, siteId: req.params.siteId, subcontractorId: req.params.subId, userId: req.user?.id });
    audit(req, 'sub_presenze.link_squadra', req.params.subId, { siteId: req.params.siteId });
    res.status(201).json({ url: `${baseUrl()}/squadra/${token}` });
  } catch (err) { fallito(res, err, 'link-squadra POST'); }
});

router.delete('/sites/:siteId/subcontractors/:subId/link-squadra', verifySupabaseJwt, async (req, res) => {
  if (!idsOk(req, res, 'siteId', 'subId') || !(await guard(req, res, true))) return;
  try {
    await S.cantiereDellAzienda(req.companyId, req.params.siteId);
    await S.revocaLinkSquadra({ companyId: req.companyId, siteId: req.params.siteId, subcontractorId: req.params.subId });
    audit(req, 'sub_presenze.link_squadra_revocato', req.params.subId, { siteId: req.params.siteId });
    res.json({ ok: true });
  } catch (err) { fallito(res, err, 'link-squadra DELETE'); }
});

router.get('/sites/:siteId/subcontractors/:subId/persone', verifySupabaseJwt, async (req, res) => {
  if (!idsOk(req, res, 'siteId', 'subId') || !(await guard(req, res, false))) return;
  try {
    await S.cantiereDellAzienda(req.companyId, req.params.siteId);
    const persone = await S.personeDelSub(req.companyId, req.params.subId);
    res.json(persone.map(p => ({ id: p.id, nome: p.full_name, conCodiceFiscale: !!p.fiscal_code })));
  } catch (err) { fallito(res, err, 'persone GET'); }
});

router.post('/sites/:siteId/subcontractors/:subId/persone', verifySupabaseJwt, async (req, res) => {
  if (!idsOk(req, res, 'siteId', 'subId') || !(await guard(req, res, true))) return;
  try {
    await S.cantiereDellAzienda(req.companyId, req.params.siteId);
    const supabase = require('../../lib/supabase');
    const { data: sub } = await supabase.from('subcontractors').select('id').eq('id', req.params.subId).eq('company_id', req.companyId).maybeSingle();
    if (!sub) return res.status(404).json({ error: 'NOT_FOUND' });
    const r = await S.aggiungiPersona({ companyId: req.companyId, subcontractorId: sub.id, fullName: req.body?.full_name, addedVia: 'ufficio' });
    audit(req, 'sub_presenze.persona', r.id, { subcontractorId: sub.id });
    res.status(r.unchanged ? 200 : 201).json(r);
  } catch (err) { fallito(res, err, 'persone POST'); }
});

router.post('/sites/:siteId/sub-presenze', verifySupabaseJwt, async (req, res) => {
  if (!idsOk(req, res, 'siteId') || !(await guard(req, res, true))) return;
  const { sub_worker_id, event } = req.body || {};
  if (!UUID.test(String(sub_worker_id || ''))) return res.status(400).json({ error: 'SUB_WORKER_ID_REQUIRED' });
  try {
    const r = await S.segnaDaUfficio({ companyId: req.companyId, userId: req.user?.id, siteId: req.params.siteId, subWorkerId: sub_worker_id, event });
    if (!r.unchanged) audit(req, 'sub_presenze.segna', r.id, { siteId: req.params.siteId, subWorkerId: sub_worker_id, event: r.event });
    res.json(r);
  } catch (err) { fallito(res, err, 'sub-presenze POST'); }
});

router.post('/sub-presenze/:id/annulla', verifySupabaseJwt, async (req, res) => {
  if (!idsOk(req, res, 'id') || !(await guard(req, res, true))) return;
  try {
    const r = await S.annulla({ companyId: req.companyId, userId: req.user?.id, presenzaId: req.params.id });
    audit(req, 'sub_presenze.annulla', req.params.id, {});
    res.json(r);
  } catch (err) { fallito(res, err, 'sub-presenze annulla'); }
});

router.post('/sub-impresa-ignota/:id/chiudi', verifySupabaseJwt, async (req, res) => {
  if (!idsOk(req, res, 'id') || !(await guard(req, res, true))) return;
  const { come, subcontractor_id } = req.body || {};
  if (subcontractor_id && !UUID.test(String(subcontractor_id))) return res.status(400).json({ error: 'SUBCONTRACTOR_ID_REQUIRED' });
  try {
    const r = await S.chiudiIgnota({ companyId: req.companyId, userId: req.user?.id, id: req.params.id, come, subcontractorId: subcontractor_id || null });
    audit(req, 'sub_presenze.impresa_ignota', req.params.id, { come, subcontractorId: subcontractor_id || null });
    res.json(r);
  } catch (err) { fallito(res, err, 'impresa-ignota chiudi'); }
});

// ── Cartello "Ingresso cantiere" ────────────────────────────────────────────
// Il QR vale fino alla fine del cantiere (o un anno, se non c'è una fine), così
// il cartello appeso non scade dopo 7 giorni come il QR del capocantiere.
const esc = (s) => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SCRITTE = [
  ['Inquadra con il telefono per entrare e uscire', 'Scanează cu telefonul la intrare și la ieșire', 'Skano me telefon kur hyn dhe kur del', 'امسح الرمز بهاتفك عند الدخول والخروج'],
  ['Registriamo solo quando entri ed esci da questo cantiere, per la sicurezza.', 'Înregistrăm doar când intri și ieși de pe acest șantier, pentru siguranță.', 'Regjistrojmë vetëm kur hyn dhe del nga ky kantier, për sigurinë.', 'نسجّل فقط وقت دخولك وخروجك من هذه الورشة، من أجل السلامة.'],
];

router.get('/sites/:siteId/cartello-ingresso', verifySupabaseJwt, async (req, res) => {
  if (!idsOk(req, res, 'siteId') || !(await guard(req, res, false))) return;
  try {
    const site = await S.cantiereDellAzienda(req.companyId, req.params.siteId);
    const supabase = require('../../lib/supabase');
    const [{ data: extra }, { data: company }] = await Promise.all([
      supabase.from('sites').select('end_date').eq('id', site.id).maybeSingle(),
      supabase.from('companies').select('name').eq('id', req.companyId).maybeSingle(),
    ]);
    const anno = Math.floor(Date.now() / 1000) + 365 * 86400;
    const fine = extra?.end_date ? Math.floor(Date.parse(`${extra.end_date}T23:59:59Z`) / 1000) + 30 * 86400 : 0;
    const exp = Math.max(anno, fine);
    const url = `${baseUrl()}/scan/${encodeURIComponent(site.id)}?t=${signQrToken(site.id, exp)}&exp=${exp}`;
    const qr = await QRCode.toDataURL(url, { width: 900, margin: 1, errorCorrectionLevel: 'M' });
    const righe = (i) => SCRITTE[i].map((t, k) => `<p class="${k === 3 ? 'ar' : ''}">${esc(t)}</p>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { font-family: 'Inter', Arial, sans-serif; color: #1A1714; margin: 0; text-align: center; }
      h1 { font-size: 40pt; margin: 4mm 0 2mm; letter-spacing: -0.5pt; }
      .cant { font-size: 16pt; color: #6E6459; margin: 0 0 6mm; }
      .qr { width: 115mm; height: 115mm; display: block; margin: 0 auto 6mm; }
      .big p { font-size: 17pt; font-weight: 700; margin: 1.5mm 0; }
      .small p { font-size: 10.5pt; color: #6E6459; margin: 1mm 0; }
      .ar { direction: rtl; }
      .foot { font-size: 9pt; color: #6E6459; margin-top: 8mm; }
    </style></head><body>
      <h1>Ingresso cantiere</h1>
      <p class="cant">${esc(site.name)}${site.address ? ` · ${esc(site.address)}` : ''}</p>
      <img class="qr" src="${qr}">
      <div class="big">${righe(0)}</div>
      <div class="small" style="margin-top:5mm">${righe(1)}</div>
      <p class="foot">${esc(company?.name || '')} · Valido fino al ${new Date(exp * 1000).toLocaleDateString('it-IT')}</p>
    </body></html>`;
    const { rendererPool } = require('../../pdf-renderer');
    const pdf = await rendererPool.render(html, { docTitle: `Ingresso cantiere — ${site.name}`, rev: 1 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Ingresso-${String(site.name).replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.pdf"`);
    res.send(pdf);
  } catch (err) { fallito(res, err, 'cartello-ingresso'); }
});

module.exports = router;
