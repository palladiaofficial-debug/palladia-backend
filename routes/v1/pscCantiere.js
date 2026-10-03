'use strict';
// ── Palladia per coordinatori: imprese, POS, verbali (F-270) ─────────────────
// Imprese del cantiere e loro inviti; POS ricevuti e verifica di idoneità;
// sopralluoghi e riunioni con non conformità, firma e invio alle imprese.
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const store = require('../../lib/psc/store');
const documento = require('../../lib/psc/documento');
const posVerify = require('../../lib/psc/posVerify');
const { detect } = require('../../lib/psc/interferenze');
const { ORGANIZZAZIONE } = require('../../lib/psc/catalog');
const { sendPlainLayoutEmail, emailButton } = require('../../services/email');
const { aiLimiter } = require('../../middleware/rateLimit');
const { auth, h, fail, uploader, isUuid, isPdf, isImage, str, dateOrNull, pick, safeName } = require('../../lib/psc/http');

const APP_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');
const upPos = uploader(30, (f) => isPdf(f));
const upPhoto = uploader(15, (f) => isImage(f));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PALETTE = documento.PALETTE;

async function mustProject(req, id) {
  const p = await store.getProject(req.companyId, id);
  if (!p) throw fail(404, 'Cantiere non trovato', 'NOT_FOUND');
  return p;
}
async function mustImpresa(req) {
  if (!isUuid(req.params.iid)) throw fail(404, 'Impresa non trovata', 'NOT_FOUND');
  const { data } = await supabase.from('psc_imprese').select('*').eq('id', req.params.iid).eq('company_id', req.companyId).maybeSingle();
  if (!data) throw fail(404, 'Impresa non trovata', 'NOT_FOUND');
  return data;
}
const touch = (projectId) => { supabase.from('psc_projects').update({ updated_at: new Date().toISOString() }).eq('id', projectId).then(() => {}, () => {}); };

// ── Imprese ─────────────────────────────────────────────────────────────────
const IMPRESA_FIELDS = {
  ragione_sociale: (v) => str(v, 200), piva: (v) => (v === null || v === '' ? null : /^[0-9A-Za-z]{8,16}$/.test(String(v).replace(/\s/g, '')) ? String(v).replace(/\s/g, '').toUpperCase() : undefined),
  email: (v) => (v === null || v === '' ? null : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()) ? String(v).trim().toLowerCase() : undefined),
  telefono: (v) => str(v, 40), referente: (v) => str(v, 120), ruolo: (v) => (['affidataria', 'esecutrice', 'autonomo'].includes(v) ? v : undefined),
  pos_due_date: dateOrNull,
};

router.post('/psc/projects/:id/imprese', ...auth, h(async (req, res) => {
  const p = await mustProject(req, req.params.id);
  const b = pick(req.body, IMPRESA_FIELDS);
  if (!b.ragione_sociale || b.ragione_sociale.length < 2) throw fail(400, 'Scrivi la ragione sociale', 'NAME_REQUIRED');
  const { count } = await supabase.from('psc_imprese').select('id', { count: 'exact', head: true }).eq('project_id', p.id);
  if (b.ruolo === 'affidataria') await supabase.from('psc_imprese').update({ ruolo: 'esecutrice' }).eq('project_id', p.id).eq('ruolo', 'affidataria');
  const { data, error } = await supabase.from('psc_imprese').insert({ ...b, project_id: p.id, company_id: req.companyId, color: PALETTE[(count || 0) % PALETTE.length] }).select('*').single();
  if (error) throw error;
  touch(p.id);
  res.status(201).json({ impresa: data });
}));

router.patch('/psc/imprese/:iid', ...auth, h(async (req, res) => {
  const i = await mustImpresa(req);
  const b = pick(req.body, IMPRESA_FIELDS);
  if ('ragione_sociale' in b && (!b.ragione_sociale || b.ragione_sociale.length < 2)) throw fail(400, 'La ragione sociale non può essere vuota');
  if (b.ruolo === 'affidataria') await supabase.from('psc_imprese').update({ ruolo: 'esecutrice' }).eq('project_id', i.project_id).eq('ruolo', 'affidataria').neq('id', i.id);
  const { data, error } = await supabase.from('psc_imprese').update(b).eq('id', i.id).select('*').single();
  if (error) throw error;
  touch(i.project_id);
  res.json({ impresa: data });
}));

router.delete('/psc/imprese/:iid', ...auth, h(async (req, res) => {
  const i = await mustImpresa(req);
  await supabase.from('psc_imprese').delete().eq('id', i.id);
  touch(i.project_id);
  res.json({ ok: true });
}));

/** Invito all'impresa: link personale, email con il riepilogo di ciò che è già pronto. */
router.post('/psc/imprese/:iid/invita', ...auth, h(async (req, res) => {
  const i = await mustImpresa(req);
  const b = pick(req.body, { pos_due_date: dateOrNull, messaggio: (v) => str(v, 2000), invia_email: (v) => (typeof v === 'boolean' ? v : undefined) });
  const all = await store.loadAll(req.companyId, i.project_id);
  const p = all.project;
  const token = i.invite_token || store.token();
  const due = b.pos_due_date !== undefined ? b.pos_due_date : i.pos_due_date;
  await supabase.from('psc_imprese').update({ invite_token: token, invited_at: new Date().toISOString(), pos_due_date: due, pos_status: ['idoneo', 'ricevuto'].includes(i.pos_status) ? i.pos_status : 'richiesto' }).eq('id', i.id);
  const url = `${APP_URL}/psc/invito/${token}`;
  let emailed = false;
  const cse = (p.soggetti && p.soggetti.cse) || {};
  if (b.invia_email !== false && i.email && process.env.RESEND_API_KEY) {
    const lav = all.lavorazioni.filter(l => l.impresa_id === i.id);
    const body = `
      <p style="margin:0 0 16px;font-size:15px;color:#3E3A32;line-height:1.6;"><b>${esc(cse.nome || 'Il coordinatore per la sicurezza')}</b> ti chiede il POS per il cantiere <b>${esc(p.title)}</b>${p.comune ? `, ${esc(p.comune)}` : ''}${due ? `, entro il <b>${new Date(due).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}</b>` : ''}.</p>
      ${b.messaggio ? `<p style="margin:0 0 16px;font-size:15px;color:#3E3A32;line-height:1.6;white-space:pre-line;">${esc(b.messaggio)}</p>` : ''}
      <p style="margin:0 0 6px;font-size:14px;color:#3E3A32;"><b>Già pronto per te nel link:</b></p>
      <ul style="margin:0 0 8px 18px;padding:0;font-size:14px;color:#3E3A32;line-height:1.7;">
        ${lav.length ? `<li>le tue lavorazioni: ${esc(lav.map(l => l.nome).join(', '))}</li>` : ''}
        <li>le regole del cantiere, le prescrizioni del PSC e i numeri di emergenza</li>
        <li>il PSC da scaricare</li>
      </ul>
      ${emailButton('Apri e carica il POS', url)}
      <p style="margin:24px 0 0;font-size:12.5px;color:#8A8171;line-height:1.6;">Non serve un account. Il link è personale: non inoltrarlo fuori dalla tua impresa.</p>`;
    try {
      const r = await sendPlainLayoutEmail({ to: i.email, subject: `POS richiesto per il cantiere ${p.title}`, title: `Ti è stato chiesto il POS`, bodyHtml: body, replyTo: cse.email || undefined });
      emailed = !(r && r.error);
      if (r && r.error) console.error('[psc invito] email:', JSON.stringify(r.error));
    } catch (e) { console.error('[psc invito] email:', e.message); }
  }
  res.json({ ok: true, url, emailed });
}));

// POS ricevuto per email e caricato dal coordinatore
router.post('/psc/imprese/:iid/pos', ...auth, upPos('file'), h(async (req, res) => {
  const i = await mustImpresa(req);
  if (!req.file) throw fail(400, 'Scegli il PDF del POS');
  const path = `${req.companyId}/${i.project_id}/pos/${i.id}-${Date.now()}.pdf`;
  await store.upload(path, req.file.buffer, 'application/pdf');
  await supabase.from('psc_imprese').update({ pos_path: path, pos_name: req.file.originalname.slice(0, 200), pos_status: 'ricevuto', pos_received_at: new Date().toISOString() }).eq('id', i.id);
  res.json({ ok: true });
}));

router.get('/psc/imprese/:iid/pos', ...auth, h(async (req, res) => {
  const i = await mustImpresa(req);
  if (!i.pos_path) throw fail(404, 'POS non ancora ricevuto');
  res.json({ url: await store.signedUrl(i.pos_path, 600), name: i.pos_name });
}));

/** Prescrizioni del PSC che il POS di questa impresa deve recepire. */
function prescrizioniPer(impresaId, all) {
  const lavById = new Map(all.lavorazioni.map(l => [l.id, l]));
  const mine = new Set(all.lavorazioni.filter(l => l.impresa_id === impresaId).map(l => l.id));
  const out = [];
  for (const d of all.decisioni) {
    if (!mine.has(d.lav_a) && !mine.has(d.lav_b)) continue;
    const a = lavById.get(d.lav_a), b = lavById.get(d.lav_b);
    out.push({ id: `int-${d.id.slice(0, 8)}`, titolo: `interferenza ${a ? a.nome : ''} × ${b ? b.nome : ''}`, testo: d.testo });
  }
  for (const u of all.project.uso_comune || []) if (u.testo && u.approvata !== false && (!u.impresa_id || u.impresa_id === impresaId)) out.push({ id: `uso-${u.key || out.length}`, titolo: `uso comune: ${u.titolo}`, testo: u.testo });
  return out.slice(0, 15);
}

router.post('/psc/imprese/:iid/verifica', ...auth, aiLimiter, h(async (req, res) => {
  const i = await mustImpresa(req);
  if (!i.pos_path) throw fail(400, 'Il POS non è ancora arrivato', 'NO_POS');
  const all = await store.loadAll(req.companyId, i.project_id);
  const buffer = await store.download(i.pos_path);
  const lavorazioniImpresa = all.lavorazioni.filter(l => l.impresa_id === i.id).map(l => ({ nome: l.nome, scheda_id: l.scheda_id }));
  const prescrizioni = prescrizioniPer(i.id, all);
  const r = await posVerify.verifica({ buffer, mime: 'application/pdf', companyId: req.companyId, userId: req.user.id, impresa: i.ragione_sociale, lavorazioniImpresa, prescrizioni });
  if (!r.isPos) throw fail(422, 'Questo documento non sembra un POS', 'NOT_A_POS');
  const cse = (all.project.soggetti && all.project.soggetti.cse) || {};
  const messaggio = posVerify.messaggio({ impresa: i.ragione_sociale, cantiere: all.project.title, cse: [cse.nome, cse.qualifica].filter(Boolean).join(', ') || 'Il coordinatore per la sicurezza', esitoCheck: r.checks });
  const { data, error } = await supabase.from('psc_pos_checks').insert({
    project_id: i.project_id, company_id: req.companyId, impresa_id: i.id, pos_path: i.pos_path, num_pages: r.numPages, checks: r.checks, messaggio,
  }).select('*').single();
  if (error) throw error;
  res.json({ check: data, riepilogo: r.riepilogo, source: r.source });
}));

router.get('/psc/imprese/:iid/verifiche', ...auth, h(async (req, res) => {
  const i = await mustImpresa(req);
  const { data } = await supabase.from('psc_pos_checks').select('*').eq('impresa_id', i.id).order('created_at', { ascending: false }).limit(20);
  res.json({ verifiche: data || [] });
}));

router.post('/psc/pos-checks/:cid/esito', ...auth, h(async (req, res) => {
  if (!isUuid(req.params.cid)) throw fail(404, 'Non trovata');
  const { data: c } = await supabase.from('psc_pos_checks').select('*').eq('id', req.params.cid).eq('company_id', req.companyId).maybeSingle();
  if (!c) throw fail(404, 'Verifica non trovata');
  const b = pick(req.body, { esito: (v) => (['idoneo', 'da_integrare'].includes(v) ? v : undefined), messaggio: (v) => str(v, 6000), invia: (v) => (typeof v === 'boolean' ? v : undefined) });
  if (!b.esito) throw fail(400, 'Scegli l\'esito');
  const { data: i } = await supabase.from('psc_imprese').select('*').eq('id', c.impresa_id).maybeSingle();
  const p = await store.getProject(req.companyId, c.project_id);
  let sent = false;
  if (b.invia && i && i.email && process.env.RESEND_API_KEY) {
    const cse = (p.soggetti && p.soggetti.cse) || {};
    const token = i.invite_token || store.token();
    if (!i.invite_token) await supabase.from('psc_imprese').update({ invite_token: token }).eq('id', i.id);
    const body = `<p style="margin:0 0 16px;font-size:15px;color:#3E3A32;line-height:1.65;white-space:pre-line;">${esc(b.messaggio || c.messaggio)}</p>${b.esito === 'da_integrare' ? emailButton('Carica il POS aggiornato', `${APP_URL}/psc/invito/${token}`) : ''}`;
    try {
      const r = await sendPlainLayoutEmail({ to: i.email, subject: b.esito === 'idoneo' ? `POS idoneo · ${p.title}` : `POS da integrare · ${p.title}`, title: b.esito === 'idoneo' ? 'Il vostro POS è idoneo' : 'Il vostro POS va integrato', bodyHtml: body, replyTo: cse.email || undefined });
      sent = !(r && r.error);
    } catch (e) { console.error('[psc esito] email:', e.message); }
  }
  await supabase.from('psc_pos_checks').update({ esito: b.esito, messaggio: b.messaggio || c.messaggio, sent_at: sent ? new Date().toISOString() : null, decided_by: req.user.id }).eq('id', c.id);
  if (i) await supabase.from('psc_imprese').update({ pos_status: b.esito }).eq('id', i.id);
  res.json({ ok: true, inviato: sent });
}));

// ── Verbali ─────────────────────────────────────────────────────────────────
async function mustVerbale(req) {
  if (!isUuid(req.params.vid)) throw fail(404, 'Verbale non trovato');
  const { data } = await supabase.from('psc_verbali').select('*').eq('id', req.params.vid).eq('company_id', req.companyId).maybeSingle();
  if (!data) throw fail(404, 'Verbale non trovato');
  return data;
}

router.get('/psc/projects/:id/verbali', ...auth, h(async (req, res) => {
  const p = await mustProject(req, req.params.id);
  const [{ data: v }, { data: nc }] = await Promise.all([
    supabase.from('psc_verbali').select('id, numero, tipo, data, status, signed_at, sent_to').eq('project_id', p.id).order('numero', { ascending: false }),
    supabase.from('psc_nc').select('*').eq('project_id', p.id).order('created_at', { ascending: false }),
  ]);
  res.json({ verbali: v || [], nc: nc || [] });
}));

router.post('/psc/projects/:id/verbali', ...auth, h(async (req, res) => {
  const all = await store.loadAll(req.companyId, req.params.id);
  if (!all) throw fail(404, 'Cantiere non trovato');
  const tipo = req.body && req.body.tipo === 'riunione' ? 'riunione' : 'sopralluogo';
  const { data: last } = await supabase.from('psc_verbali').select('numero').eq('project_id', all.project.id).order('numero', { ascending: false }).limit(1);
  const numero = last && last[0] ? last[0].numero + 1 : 1;
  const today = new Date().toISOString().slice(0, 10);
  const checklist = [];
  if (tipo === 'sopralluogo') {
    const org = all.project.organizzazione || {};
    for (const o of ORGANIZZAZIONE) if (!org[o.key] || org[o.key].attivo !== false) if (['recinzione', 'viabilita', 'impianti', 'servizi', 'stoccaggio', 'infiammabili'].includes(o.key)) checklist.push({ key: `org:${o.key}`, titolo: o.titolo, esito: null, nota: '' });
    for (const l of all.lavorazioni) if (l.start_date && l.end_date && l.start_date <= today && l.end_date >= today) checklist.push({ key: `lav:${l.id}`, titolo: l.nome, esito: null, nota: '', lavorazione_id: l.id });
    for (const x of ((all.project.contesto || {}).da_sopralluogo || [])) if (!x.verificato) checklist.push({ key: `ctx:${x.key}`, titolo: x.domanda || x.titolo, esito: null, nota: '', contesto_key: x.key });
    for (const d of all.decisioni) {
      const inter = detect(all.lavorazioni, all.decisioni).risolte.find(r => r.id === d.id);
      if (inter && inter.ancora_sovrapposte) checklist.push({ key: `int:${d.id}`, titolo: `Prescrizione interferenza: ${d.testo.length > 140 ? `${d.testo.slice(0, 138).replace(/\s+\S*$/, '')}…` : d.testo}`, esito: null, nota: '' });
    }
  } else {
    checklist.push({ key: 'riunione:ordine', titolo: 'Illustrazione del PSC e delle prescrizioni alle imprese presenti', esito: null, nota: '' });
    checklist.push({ key: 'riunione:crono', titolo: 'Cronoprogramma delle prossime due settimane e interferenze', esito: null, nota: '' });
    checklist.push({ key: 'riunione:uso', titolo: 'Uso comune di apprestamenti e servizi', esito: null, nota: '' });
  }
  const presenti = all.imprese.map(i => ({ nome: i.referente || '', ruolo: i.ragione_sociale, impresa_id: i.id, presente: false }));
  const { data, error } = await supabase.from('psc_verbali').insert({ project_id: all.project.id, company_id: req.companyId, numero, tipo, checklist, presenti, created_by: req.user.id }).select('*').single();
  if (error) throw error;
  res.status(201).json({ verbale: data });
}));

router.get('/psc/verbali/:vid', ...auth, h(async (req, res) => {
  const v = await mustVerbale(req);
  const all = await store.loadAll(req.companyId, v.project_id);
  const { data: nc } = await supabase.from('psc_nc').select('*').eq('verbale_id', v.id).order('created_at');
  let presenze = null;
  try { presenze = await store.presenzeOggi(all.imprese); } catch { presenze = null; }
  const photos = {};
  for (const n of nc || []) for (const pth of [...(n.photo_paths || []), ...(n.close_photo_paths || [])]) photos[pth] = await store.signedUrl(pth, 900);
  res.json({ verbale: v, nc: nc || [], imprese: all.imprese, project: { id: all.project.id, title: all.project.title, address: all.project.address, comune: all.project.comune }, presenze, photos });
}));

router.patch('/psc/verbali/:vid', ...auth, h(async (req, res) => {
  const v = await mustVerbale(req);
  if (v.status === 'firmato') throw fail(409, 'Il verbale è già firmato', 'SIGNED');
  const b = pick(req.body, {
    osservazioni: (v2) => str(v2, 8000),
    checklist: (a) => (Array.isArray(a) ? a.slice(0, 80).map(c => ({ ...c, titolo: str(c.titolo, 300), esito: ['ok', 'no', 'na'].includes(c.esito) ? c.esito : null, nota: str(c.nota, 600) || '' })) : undefined),
    presenti: (a) => (Array.isArray(a) ? a.slice(0, 60).map(x => ({ nome: str(x.nome, 120) || '', ruolo: str(x.ruolo, 200) || '', impresa_id: isUuid(x.impresa_id) ? x.impresa_id : null, presente: x.presente !== false })) : undefined),
    data: (d) => (typeof d === 'string' && !isNaN(Date.parse(d)) ? new Date(d).toISOString() : undefined),
  });
  const { data } = await supabase.from('psc_verbali').update(b).eq('id', v.id).select('*').single();
  res.json({ verbale: data });
}));

router.delete('/psc/verbali/:vid', ...auth, h(async (req, res) => {
  const v = await mustVerbale(req);
  if (v.status === 'firmato') throw fail(409, 'Un verbale firmato non si cancella', 'SIGNED');
  await supabase.from('psc_verbali').delete().eq('id', v.id);
  res.json({ ok: true });
}));

const NC_FIELDS = {
  descrizione: (v) => str(v, 1200), impresa_id: (v) => (v === null || isUuid(v) ? v : undefined),
  gravita: (v) => (['bassa', 'media', 'alta'].includes(v) ? v : undefined), sospensione: (v) => (typeof v === 'boolean' ? v : undefined), scadenza: dateOrNull,
};

router.post('/psc/verbali/:vid/nc', ...auth, h(async (req, res) => {
  const v = await mustVerbale(req);
  if (v.status === 'firmato') throw fail(409, 'Il verbale è già firmato', 'SIGNED');
  const b = pick(req.body, NC_FIELDS);
  if (!b.descrizione) throw fail(400, 'Descrivi la non conformità');
  const { data, error } = await supabase.from('psc_nc').insert({ ...b, project_id: v.project_id, company_id: req.companyId, verbale_id: v.id, close_token: store.token() }).select('*').single();
  if (error) throw error;
  res.status(201).json({ nc: data });
}));

async function mustNc(req) {
  if (!isUuid(req.params.nid)) throw fail(404, 'Non trovata');
  const { data } = await supabase.from('psc_nc').select('*').eq('id', req.params.nid).eq('company_id', req.companyId).maybeSingle();
  if (!data) throw fail(404, 'Non conformità non trovata');
  return data;
}

router.patch('/psc/nc/:nid', ...auth, h(async (req, res) => {
  const n = await mustNc(req);
  const b = pick(req.body, NC_FIELDS);
  const { data } = await supabase.from('psc_nc').update(b).eq('id', n.id).select('*').single();
  res.json({ nc: data });
}));

router.delete('/psc/nc/:nid', ...auth, h(async (req, res) => {
  const n = await mustNc(req);
  if (n.verbale_id) {
    const { data: v } = await supabase.from('psc_verbali').select('status').eq('id', n.verbale_id).maybeSingle();
    if (v && v.status === 'firmato') throw fail(409, 'È in un verbale firmato: chiudila invece di cancellarla', 'SIGNED');
  }
  await supabase.from('psc_nc').delete().eq('id', n.id);
  res.json({ ok: true });
}));

router.post('/psc/nc/:nid/foto', ...auth, upPhoto('file'), h(async (req, res) => {
  const n = await mustNc(req);
  if (!req.file) throw fail(400, 'Scegli una foto');
  const sharp = require('sharp');
  let buf = req.file.buffer;
  try { buf = await sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer(); } catch { /* foto originale */ }
  const path = `${req.companyId}/${n.project_id}/nc/${n.id}-${Date.now()}.jpg`;
  await store.upload(path, buf, 'image/jpeg');
  const paths = [...(n.photo_paths || []), path].slice(-6);
  await supabase.from('psc_nc').update({ photo_paths: paths }).eq('id', n.id);
  res.json({ ok: true, path, url: await store.signedUrl(path, 900) });
}));

router.post('/psc/nc/:nid/chiudi', ...auth, h(async (req, res) => {
  const n = await mustNc(req);
  const riapri = req.body && req.body.riapri === true;
  await supabase.from('psc_nc').update(riapri ? { status: 'aperta', closed_at: null } : { status: 'chiusa', closed_at: new Date().toISOString() }).eq('id', n.id);
  res.json({ ok: true });
}));

/** Firma del verbale: firma disegnata, PDF, invio alle imprese con il link per chiudere le NC. */
router.post('/psc/verbali/:vid/firma', ...auth, h(async (req, res) => {
  const v = await mustVerbale(req);
  if (v.status === 'firmato') throw fail(409, 'Il verbale è già firmato', 'SIGNED');
  const b = pick(req.body, { signed_name: (x) => str(x, 160), signature: (x) => (typeof x === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(x) && x.length < 600_000 ? x : undefined), invia: (x) => (typeof x === 'boolean' ? x : undefined) });
  if (!b.signed_name) throw fail(400, 'Scrivi il tuo nome per firmare');
  if (!b.signature) throw fail(400, 'Disegna la firma', 'SIGNATURE_REQUIRED');
  const all = await store.loadAll(req.companyId, v.project_id);
  const sigPath = `${req.companyId}/${v.project_id}/verbali/firma-${v.id}.png`;
  await store.upload(sigPath, Buffer.from(b.signature.split(',')[1], 'base64'), 'image/png');
  const signedAt = new Date().toISOString();
  const verbale = { ...v, status: 'firmato', signed_name: b.signed_name, signed_at: signedAt, signature_path: sigPath };
  const { data: nc } = await supabase.from('psc_nc').select('*').eq('verbale_id', v.id).order('created_at');
  const photos = {};
  for (const n of nc || []) for (const pth of n.photo_paths || []) photos[pth] = await store.dataUri(pth, 'image/jpeg');
  let presenze = null;
  try { presenze = await store.presenzeOggi(all.imprese); } catch { presenze = null; }
  const html = documento.verbaleHtml({ project: all.project, verbale, nc: nc || [], imprese: all.imprese, photos, signatureDataUri: b.signature, presenze });
  const { rendererPool } = require('../../pdf-renderer');
  const titolo = `${v.tipo === 'riunione' ? 'Verbale riunione' : 'Verbale sopralluogo'} n. ${v.numero}`;
  const pdf = await rendererPool.render(html, { docTitle: `${titolo} · ${all.project.title}`, headerLeft: ((all.project.soggetti || {}).cse || {}).studio || 'Verbale', footerLeft: 'D.Lgs. 81/2008 · art. 92', revision: '0' });
  const pdfPath = `${req.companyId}/${v.project_id}/verbali/verbale-${v.numero}-${Date.now()}.pdf`;
  await store.upload(pdfPath, pdf, 'application/pdf');

  // Voci del contesto verificate al sopralluogo
  const ctx = all.project.contesto || {};
  let ctxChanged = false;
  for (const c of v.checklist || []) if (c.contesto_key && c.esito) {
    const x = (ctx.da_sopralluogo || []).find(d => d.key === c.contesto_key);
    if (x) { x.verificato = true; x.esito = c.nota || (c.esito === 'ok' ? 'nessun rischio rilevato' : c.esito === 'no' ? 'presente: vedi verbale' : 'non applicabile'); ctxChanged = true; }
  }
  if (ctxChanged) await supabase.from('psc_projects').update({ contesto: ctx }).eq('id', all.project.id);

  const sentTo = [];
  if (b.invia !== false && process.env.RESEND_API_KEY) {
    const cse = (all.project.soggetti && all.project.soggetti.cse) || {};
    const destinatari = all.imprese.filter(i => i.email);
    for (const i of destinatari) {
      const mie = (nc || []).filter(n => n.impresa_id === i.id);
      const body = `<p style="margin:0 0 14px;font-size:15px;color:#3E3A32;line-height:1.6;">In allegato il ${titolo.toLowerCase()} del cantiere <b>${esc(all.project.title)}</b>, firmato da ${esc(b.signed_name)}.</p>
      ${mie.length ? `<p style="margin:0 0 8px;font-size:15px;color:#A8453B;"><b>${mie.length === 1 ? 'C\'è una non conformità' : `Ci sono ${mie.length} non conformità`} per la vostra impresa:</b></p>
      ${mie.map(n => `<div style="margin:0 0 12px;padding:12px 14px;border:1px solid ${n.sospensione ? '#A8453B' : '#ECE7DF'};border-radius:12px;font-size:14px;color:#1A1714;">${esc(n.descrizione)}${n.sospensione ? '<br><b style="color:#A8453B">Lavorazione sospesa fino alla risoluzione.</b>' : ''}<br><a href="${APP_URL}/psc/nc/${n.close_token}" style="color:#22384F;font-weight:700;">Segnala che è risolta, con una foto →</a></div>`).join('')}` : ''}`;
      try {
        const r = await sendPlainLayoutEmail({
          to: i.email, subject: `${titolo} · ${all.project.title}${mie.length ? ` · ${mie.length} da risolvere` : ''}`, title: titolo, bodyHtml: body,
          replyTo: cse.email || undefined, attachments: [{ filename: `${safeName(titolo)}.pdf`, content: pdf.toString('base64') }],
        });
        if (!(r && r.error)) sentTo.push({ impresa_id: i.id, email: i.email, at: new Date().toISOString() });
      } catch (e) { console.error('[psc verbale] email:', e.message); }
    }
  }
  const { data } = await supabase.from('psc_verbali').update({ status: 'firmato', signed_name: b.signed_name, signed_at: signedAt, signature_path: sigPath, pdf_path: pdfPath, sent_to: sentTo }).eq('id', v.id).select('*').single();
  res.json({ verbale: data, inviato_a: sentTo.length, senza_email: all.imprese.filter(i => !i.email).map(i => i.ragione_sociale) });
}));

router.get('/psc/verbali/:vid/pdf', ...auth, h(async (req, res) => {
  const v = await mustVerbale(req);
  if (!v.pdf_path) throw fail(404, 'Il PDF si crea alla firma');
  res.json({ url: await store.signedUrl(v.pdf_path, 600, `Verbale-${v.numero}.pdf`) });
}));

module.exports = router;
