'use strict';
// ── Palladia per coordinatori: pagine pubbliche e prova (F-270) ──────────────
//  - /psc-pub/invito/:token   l'impresa invitata, senza account: vede ciò che è
//    già pronto, scarica il PSC, carica il POS. Con un account Palladia può
//    collegarsi e creare il POS con i dati del PSC già dentro.
//  - /psc-pub/nc/:token       l'impresa segnala risolta una non conformità, con foto.
//  - /psc-beta/:code          verifica di un codice di invito alla prova.
//  - /psc/beta-invites        (solo founder) crea ed elenca i codici.
// Montato PRIMA dei router con verifySupabaseJwt globale (index.js).
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const store = require('../../lib/psc/store');
const beta = require('../../lib/psc/beta');
const { ORGANIZZAZIONE } = require('../../lib/psc/catalog');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { coordinatorLimiter } = require('../../middleware/rateLimit');
const { isFounder } = require('../../lib/founder');
const { sendPlainLayoutEmail, emailButton } = require('../../services/email');
const { h, fail, uploader, isUuid, isPdf, isImage, str, safeName } = require('../../lib/psc/http');

const APP_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const upPos = uploader(30, (f) => isPdf(f));
const upPhoto = uploader(15, (f) => isImage(f));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function byInvite(token) {
  if (!TOKEN_RE.test(String(token || ''))) throw fail(404, 'Link non valido', 'NOT_FOUND');
  const { data: i } = await supabase.from('psc_imprese').select('*').eq('invite_token', token).maybeSingle();
  if (!i) throw fail(404, 'Questo link non è più valido. Chiedi al coordinatore di mandartelo di nuovo.', 'NOT_FOUND');
  const all = await store.loadAll(i.company_id, i.project_id);
  if (!all) throw fail(404, 'Il cantiere non esiste più', 'NOT_FOUND');
  return { impresa: i, all };
}

function vistaImpresa(i, all) {
  const p = all.project;
  const cse = (p.soggetti && p.soggetti.cse) || {};
  const mie = all.lavorazioni.filter(l => l.impresa_id === i.id);
  const lavById = new Map(all.lavorazioni.map(l => [l.id, l]));
  const mineIds = new Set(mie.map(l => l.id));
  const regole = all.decisioni.filter(d => mineIds.has(d.lav_a) || mineIds.has(d.lav_b)).map(d => {
    const a = lavById.get(d.lav_a), b = lavById.get(d.lav_b);
    return { titolo: `${a ? a.nome : ''} × ${b ? b.nome : ''}`, testo: d.testo };
  });
  const org = p.organizzazione || {};
  const firmata = all.revisioni.length ? all.revisioni[all.revisioni.length - 1] : null;
  const em = p.emergenze || {};
  return {
    impresa: { ragione_sociale: i.ragione_sociale, ruolo: i.ruolo, pos_status: i.pos_status, pos_due_date: i.pos_due_date, pos_name: i.pos_name, pos_received_at: i.pos_received_at, collegata: !!i.linked_company_id },
    cantiere: { title: p.title, address: p.address, comune: p.comune, start_date: p.start_date, end_date: p.end_date },
    cse: { nome: cse.nome || '', qualifica: cse.qualifica || '', studio: cse.studio || '', telefono: cse.telefono || '', email: cse.email || '' },
    lavorazioni: mie.map(l => ({ nome: l.nome, start_date: l.start_date, end_date: l.end_date, area: l.area })),
    regole,
    uso_comune: (p.uso_comune || []).filter(u => u.testo && u.approvata !== false).map(u => ({ titolo: u.titolo, testo: u.testo })),
    cantiere_regole: ORGANIZZAZIONE.filter(o => org[o.key] && org[o.key].attivo !== false && org[o.key].testo && org[o.key].approvata !== false).slice(0, 6).map(o => o.titolo),
    orari: (p.testi && p.testi.orari) || null,
    emergenze: { pronto_soccorso: em.pronto_soccorso || null, punto_raccolta: em.punto_raccolta || null },
    psc: firmata ? { revision: firmata.revision, data: firmata.created_at } : null,
    // Accettazione del PSC (art. 100 c.5): vale per l'ultima revisione firmata
    accettazione: {
      rev: i.psc_accettato_rev, at: i.psc_accettato_at, da: i.psc_accettato_da,
      da_fare: !!firmata && (i.psc_accettato_rev == null || i.psc_accettato_rev < firmata.revision),
    },
  };
}

router.get('/psc-pub/invito/:token', coordinatorLimiter, h(async (req, res) => {
  const { impresa: i, all } = await byInvite(req.params.token);
  if (!i.opened_at) await supabase.from('psc_imprese').update({ opened_at: new Date().toISOString() }).eq('id', i.id);
  const { data: last } = await supabase.from('psc_pos_checks').select('esito, messaggio, sent_at, created_at').eq('impresa_id', i.id).not('esito', 'is', null).order('created_at', { ascending: false }).limit(1);
  // Le non conformità aperte di questa impresa, ognuna con il suo link di chiusura
  const { data: nc } = await supabase.from('psc_nc').select('descrizione, sospensione, scadenza, status, close_token, created_at')
    .eq('impresa_id', i.id).neq('status', 'chiusa').order('created_at', { ascending: false }).limit(20);
  res.json({ ...vistaImpresa(i, all), ultimo_esito: last && last[0] && last[0].sent_at ? last[0] : null, nc: (nc || []).map(n => ({ ...n, link: `/psc/nc/${n.close_token}`, close_token: undefined })) });
}));

router.get('/psc-pub/invito/:token/psc', coordinatorLimiter, h(async (req, res) => {
  const { all } = await byInvite(req.params.token);
  const firmata = all.revisioni.length ? all.revisioni[all.revisioni.length - 1] : null;
  if (!firmata) throw fail(404, 'Il coordinatore non ha ancora firmato il PSC', 'NOT_SIGNED');
  const { data: r } = await supabase.from('psc_revisions').select('pdf_path, signed_path, signed_name, revision').eq('id', firmata.id).maybeSingle();
  const path = r.signed_path || r.pdf_path;
  res.json({ url: await store.signedUrl(path, 600, r.signed_path ? r.signed_name : `PSC-${safeName(all.project.title)}-rev${r.revision}.pdf`), revision: r.revision });
}));

async function notificaCse(all, i, cosa) {
  const cse = (all.project.soggetti && all.project.soggetti.cse) || {};
  if (!cse.email || !process.env.RESEND_API_KEY) return;
  try {
    await sendPlainLayoutEmail({
      to: cse.email, subject: `${i.ragione_sociale} ha consegnato il POS · ${all.project.title}`,
      title: 'È arrivato un POS da verificare',
      bodyHtml: `<p style="margin:0 0 14px;font-size:15px;color:#3E3A32;line-height:1.6;"><b>${esc(i.ragione_sociale)}</b> ha ${cosa} per il cantiere <b>${esc(all.project.title)}</b>. Palladia lo controlla con te in meno di un minuto.</p>${emailButton('Verifica il POS', `${APP_URL}/coordinatori/cantieri/${all.project.id}/imprese`)}`,
    });
  } catch (e) { console.error('[psc pos ricevuto] email:', e.message); }
}

router.post('/psc-pub/invito/:token/pos', coordinatorLimiter, upPos('file'), h(async (req, res) => {
  const { impresa: i, all } = await byInvite(req.params.token);
  if (!req.file) throw fail(400, 'Scegli il PDF del POS');
  const path = `${i.company_id}/${i.project_id}/pos/${i.id}-${Date.now()}.pdf`;
  await store.upload(path, req.file.buffer, 'application/pdf');
  await supabase.from('psc_imprese').update({ pos_path: path, pos_name: req.file.originalname.slice(0, 200), pos_status: 'ricevuto', pos_received_at: new Date().toISOString() }).eq('id', i.id);
  notificaCse(all, i, 'caricato il POS');
  res.json({ ok: true });
}));

// ── Accettazione del PSC (art. 100 c.5; consultazione RLS, art. 102) ────────
router.post('/psc-pub/invito/:token/accetta', coordinatorLimiter, h(async (req, res) => {
  const { impresa: i, all } = await byInvite(req.params.token);
  const firmata = all.revisioni.length ? all.revisioni[all.revisioni.length - 1] : null;
  if (!firmata) throw fail(409, 'Il coordinatore non ha ancora firmato il PSC', 'NOT_SIGNED');
  const nome = str(req.body && req.body.nome, 120);
  if (!nome || nome.length < 3) throw fail(400, 'Scrivi nome e cognome del datore di lavoro', 'NAME_REQUIRED');
  if (!(req.body && req.body.rls_consultato === true)) throw fail(400, 'Conferma di aver consultato il rappresentante dei lavoratori (RLS)', 'RLS_REQUIRED');
  const proposte = str(req.body && req.body.proposte, 3000) || null;
  await supabase.from('psc_imprese').update({
    psc_accettato_rev: firmata.revision, psc_accettato_at: new Date().toISOString(), psc_accettato_da: nome,
    rls_consultato: true, psc_proposte: proposte,
  }).eq('id', i.id);
  const cse = (all.project.soggetti && all.project.soggetti.cse) || {};
  if (cse.email && process.env.RESEND_API_KEY) {
    sendPlainLayoutEmail({
      to: cse.email, subject: `${i.ragione_sociale} ha accettato il PSC rev. ${firmata.revision} · ${all.project.title}`,
      title: proposte ? 'PSC accettato, con proposte di integrazione' : 'PSC accettato',
      bodyHtml: `<p style="margin:0 0 14px;font-size:15px;color:#3E3A32;line-height:1.6;"><b>${esc(i.ragione_sociale)}</b> (${esc(nome)}) ha accettato il PSC rev. ${firmata.revision} di <b>${esc(all.project.title)}</b> e dichiara di aver consultato il proprio RLS.</p>${proposte ? `<p style="margin:0 0 6px;font-size:14px;color:#3E3A32;"><b>Proposte di integrazione:</b></p><p style="margin:0 0 14px;font-size:14px;color:#3E3A32;line-height:1.6;white-space:pre-line;">${esc(proposte)}</p>` : ''}${emailButton('Apri il cantiere', `${APP_URL}/coordinatori/cantieri/${all.project.id}/imprese`)}`,
    }).catch(e => console.error('[psc accetta] email:', e.message));
  }
  res.json({ ok: true, revision: firmata.revision });
}));

// ── Impresa con account Palladia: i suoi cantieri, per collegare quello giusto ──
router.get('/psc-pub/invito/:token/miei-cantieri', verifySupabaseJwt, h(async (req, res) => {
  await byInvite(req.params.token);
  const { data } = await supabase.from('sites').select('id, name, address, status').eq('company_id', req.companyId)
    .neq('status', 'eliminato').order('created_at', { ascending: false }).limit(100);
  res.json({ cantieri: data || [] });
}));

// ── Impresa con account Palladia: collega e crea il POS con i dati del PSC ──
router.post('/psc-pub/invito/:token/collega', verifySupabaseJwt, h(async (req, res) => {
  const { impresa: i } = await byInvite(req.params.token);
  const siteId = isUuid(req.body && req.body.site_id) ? req.body.site_id : null;
  if (siteId) {
    const { data: s } = await supabase.from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
    if (!s) throw fail(400, 'Cantiere non trovato tra i tuoi');
  }
  if (i.linked_company_id && i.linked_company_id !== req.companyId) throw fail(409, 'Questo invito è già collegato a un\'altra azienda', 'ALREADY_LINKED');
  await supabase.from('psc_imprese').update({ linked_company_id: req.companyId, linked_site_id: siteId || i.linked_site_id || null }).eq('id', i.id);
  res.json({ ok: true });
}));

router.get('/psc-pub/invito/:token/prefill', verifySupabaseJwt, h(async (req, res) => {
  const { impresa: i, all } = await byInvite(req.params.token);
  if (i.linked_company_id !== req.companyId) throw fail(403, 'Collega prima la tua azienda a questo invito', 'NOT_LINKED');
  const p = all.project;
  const s = p.soggetti || {};
  const v = vistaImpresa(i, all);
  const orari = (p.testi && p.testi.orari) || '';
  const m = orari.match(/(\d{1,2})[:.](\d{2})\D+(\d{1,2})[:.](\d{2})(?:\D+(\d{1,2})[:.](\d{2})\D+(\d{1,2})[:.](\d{2}))?/);
  const hh = (a, b) => (a ? `${a.padStart(2, '0')}:${b}` : '');
  const firmata = all.revisioni.length ? all.revisioni[all.revisioni.length - 1] : null;
  // Stessa forma della lettura PSC di /pos/crea (lib/pscExtract.js → PscData)
  res.json({
    isPsc: true,
    riferimento: firmata ? `PSC rev. ${firmata.revision} del ${new Date(firmata.created_at).toLocaleDateString('it-IT')}` : `PSC in redazione (${p.title})`,
    committente: (s.committente && s.committente.nome) || '', cfCommittente: (s.committente && s.committente.cf) || '',
    responsabileLavori: (s.responsabile_lavori && s.responsabile_lavori.nome) || '', csp: (s.csp && s.csp.nome) || '',
    cse: { nome: v.cse.nome, telefono: v.cse.telefono, email: v.cse.email },
    indirizzo: require('../../lib/psc/documento').luogo(p.address, p.comune), dataInizio: p.start_date || '', dataFine: p.end_date || '',
    importo: p.importo_lavori ? String(p.importo_lavori) : '',
    orarioInizio: m ? hh(m[1], m[2]) : '', orarioFine: m ? (m[7] ? hh(m[7], m[8]) : hh(m[3], m[4])) : '', pausaMinuti: m && m[5] ? Math.max(0, (Number(m[5]) * 60 + Number(m[6])) - (Number(m[3]) * 60 + Number(m[4]))) : null,
    fasi: v.lavorazioni.map(l => ({ titolo: l.nome, pagina: null })),
    richieste: [...v.regole.map(r => ({ titolo: `Interferenza ${r.titolo}`, dettaglio: r.testo, pagina: null })), ...v.uso_comune.map(u => ({ titolo: `Uso comune: ${u.titolo}`, dettaglio: u.testo, pagina: null }))].slice(0, 12),
    interferenze: v.regole.map(r => ({ titolo: r.titolo, pagina: null })).slice(0, 8),
    pagine: { committente: null, cse: null, date: null, orari: null },
    numPages: 0, source: 'palladia', documentId: '', fileName: `PSC di ${v.cse.nome || 'coordinatore'} (Palladia)`,
  });
}));

router.post('/psc-pub/invito/:token/pos-palladia', verifySupabaseJwt, h(async (req, res) => {
  const { impresa: i, all } = await byInvite(req.params.token);
  if (i.linked_company_id !== req.companyId) throw fail(403, 'Collega prima la tua azienda a questo invito', 'NOT_LINKED');
  const posId = req.body && req.body.pos_id;
  if (!isUuid(posId)) throw fail(400, 'POS mancante');
  const { data: pos } = await supabase.from('pos_documents').select('*').eq('id', posId).eq('company_id', req.companyId).maybeSingle();
  if (!pos) throw fail(404, 'POS non trovato');
  const { generatePosHtml } = require('../../pos-html-generator');
  const { selectSigns } = require('../../sign-selector');
  const { rendererPool } = require('../../pdf-renderer');
  const html = await generatePosHtml(pos.pos_data || {}, pos.revision, pos.content || '', selectSigns(pos.pos_data || {}));
  const pdf = await rendererPool.render(html, { docTitle: `POS – ${all.project.title} – Rev. ${pos.revision}`, revision: pos.revision });
  const path = `${i.company_id}/${i.project_id}/pos/${i.id}-${Date.now()}.pdf`;
  await store.upload(path, pdf, 'application/pdf');
  await supabase.from('psc_imprese').update({ pos_path: path, pos_name: `POS ${i.ragione_sociale} rev ${pos.revision}.pdf`, pos_status: 'ricevuto', pos_received_at: new Date().toISOString() }).eq('id', i.id);
  notificaCse(all, i, 'inviato il POS fatto con Palladia');
  res.json({ ok: true });
}));

// ── Non conformità: l'impresa segnala che è risolta ─────────────────────────
async function byNc(token) {
  if (!TOKEN_RE.test(String(token || ''))) throw fail(404, 'Link non valido');
  const { data: n } = await supabase.from('psc_nc').select('*').eq('close_token', token).maybeSingle();
  if (!n) throw fail(404, 'Questo link non è più valido');
  const p = await store.getProject(n.company_id, n.project_id);
  if (!p) throw fail(404, 'Il cantiere non esiste più');
  return { n, p };
}

router.get('/psc-pub/nc/:token', coordinatorLimiter, h(async (req, res) => {
  const { n, p } = await byNc(req.params.token);
  const photos = [];
  for (const pth of n.photo_paths || []) photos.push(await store.signedUrl(pth, 900));
  const { data: imp } = n.impresa_id ? await supabase.from('psc_imprese').select('ragione_sociale').eq('id', n.impresa_id).maybeSingle() : { data: null };
  const cse = (p.soggetti && p.soggetti.cse) || {};
  res.json({
    descrizione: n.descrizione, gravita: n.gravita, sospensione: n.sospensione, scadenza: n.scadenza, status: n.status, created_at: n.created_at,
    foto: photos.filter(Boolean), impresa: imp ? imp.ragione_sociale : null,
    cantiere: { title: p.title, address: p.address, comune: p.comune }, cse: { nome: cse.nome || '', telefono: cse.telefono || '' },
    chiusura: n.status !== 'aperta' ? { nota: n.close_note, quando: n.closed_reported_at } : null,
  });
}));

router.post('/psc-pub/nc/:token/risolta', coordinatorLimiter, upPhoto('files', true), h(async (req, res) => {
  const { n, p } = await byNc(req.params.token);
  if (n.status === 'chiusa') throw fail(409, 'Il coordinatore l\'ha già chiusa', 'CLOSED');
  const files = req.files || [];
  if (!files.length) throw fail(400, 'Aggiungi almeno una foto della correzione', 'PHOTO_REQUIRED');
  const sharp = require('sharp');
  const paths = [];
  for (const f of files.slice(0, 4)) {
    let buf = f.buffer;
    try { buf = await sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer(); } catch { /* originale */ }
    const path = `${n.company_id}/${n.project_id}/nc/${n.id}-risolta-${Date.now()}-${paths.length}.jpg`;
    await store.upload(path, buf, 'image/jpeg');
    paths.push(path);
  }
  await supabase.from('psc_nc').update({ status: 'segnalata_chiusa', close_note: str(req.body && req.body.nota, 1000) || null, close_photo_paths: paths, closed_reported_at: new Date().toISOString() }).eq('id', n.id);
  const cse = (p.soggetti && p.soggetti.cse) || {};
  if (cse.email && process.env.RESEND_API_KEY) {
    sendPlainLayoutEmail({
      to: cse.email, subject: `Non conformità segnalata come risolta · ${p.title}`, title: 'Un\'impresa dice di aver risolto',
      bodyHtml: `<p style="margin:0 0 14px;font-size:15px;color:#3E3A32;line-height:1.6;">"${esc(n.descrizione)}"</p><p style="margin:0 0 14px;font-size:15px;color:#3E3A32;">Ha caricato ${paths.length === 1 ? 'una foto' : `${paths.length} foto`}. Guardala e chiudi la non conformità.</p>${emailButton('Guarda e conferma', `${APP_URL}/coordinatori/cantieri/${p.id}/verbali`)}`,
    }).catch(e => console.error('[psc nc] email:', e.message));
  }
  res.json({ ok: true });
}));

// ── Prova riservata ─────────────────────────────────────────────────────────
router.get('/psc-beta/:code', coordinatorLimiter, h(async (req, res) => {
  if (beta.openSignup()) return res.json({ ok: true, aperto: true });
  const r = await beta.checkCode(req.params.code);
  res.json({ ok: r.ok, reason: r.ok ? null : r.reason, trial_days: beta.TRIAL_DAYS });
}));

function founderOnly(req, res, next) {
  if (!isFounder(req.user.id)) return res.status(403).json({ error: 'FORBIDDEN' });
  next();
}

router.get('/psc/beta-invites', verifySupabaseJwt, founderOnly, h(async (req, res) => {
  const { data } = await supabase.from('psc_beta_invites').select('code, note, created_at, used_at, used_by_company, revoked, companies:used_by_company(name)').order('created_at', { ascending: false });
  res.json({ invites: (data || []).map(x => ({ ...x, link: `${APP_URL}/coordinatori/invito/${x.code}`, usato_da: x.companies ? x.companies.name : null })) });
}));

router.post('/psc/beta-invites', verifySupabaseJwt, founderOnly, h(async (req, res) => {
  const note = str(req.body && req.body.note, 200) || null;
  for (let k = 0; k < 5; k++) {
    const code = beta.newCode();
    const { error } = await supabase.from('psc_beta_invites').insert({ code, note, created_by: req.user.id });
    if (!error) return res.status(201).json({ code, link: `${APP_URL}/coordinatori/invito/${code}` });
    if (error.code !== '23505') throw error;
  }
  throw fail(500, 'Riprova');
}));

router.post('/psc/beta-invites/:code/revoca', verifySupabaseJwt, founderOnly, h(async (req, res) => {
  await supabase.from('psc_beta_invites').update({ revoked: true }).eq('code', beta.normalize(req.params.code));
  res.json({ ok: true });
}));

module.exports = router;
