'use strict';
// ── Palladia per coordinatori: PSC (F-270, AUDIT.md del frontend) ───────────
// Rotte del coordinatore autenticato (JWT + modulo psc_coordinatori acceso):
// cantieri/PSC, opera e luogo, lavorazioni, cronoprogramma e interferenze,
// costi della sicurezza, controllo e firma, documenti, libreria.
// Imprese/POS e verbali stanno in pscCantiere.js; le pagine pubbliche
// (impresa invitata, chiusura NC) in pscPublic.js.
const router = require('express').Router();
const supabase = require('../../lib/supabase');
const store = require('../../lib/psc/store');
const L = require('../../lib/psc/lavorazioni');
const { soluzioni, detect, pairKey } = require('../../lib/psc/interferenze');
const costiLib = require('../../lib/psc/costi');
const contesto = require('../../lib/psc/contesto');
const catalog = require('../../lib/psc/catalog');
const documento = require('../../lib/psc/documento');
const importPsc = require('../../lib/psc/importPsc');
const { riconosci } = require('../../lib/psc/firma');
const { parseXpwe } = require('../../lib/psc/files');
const { parsePdf, parseExcel } = require('../../services/computoParser');
const { aiLimiter } = require('../../middleware/rateLimit');
const { auth, h, fail, uploader, isUuid, DOCX, isPdf, isImage, str, dateOrNull, numOrNull, jsonOf, pick, safeName } = require('../../lib/psc/http');

const upDocs = uploader(30, (f) => isPdf(f) || f.mimetype === DOCX || /\.docx$/i.test(f.originalname));
const upComputo = uploader(25, (f) => isPdf(f) || /\.(xlsx|xls|xpwe|xml)$/i.test(f.originalname) || /excel|spreadsheet/.test(f.mimetype));
const upLayout = uploader(20, (f) => isPdf(f) || isImage(f));
const upSigned = uploader(40, (f) => isPdf(f) || /\.p7m$/i.test(f.originalname));

async function mustProject(req) {
  const p = await store.getProject(req.companyId, req.params.id);
  if (!p) throw fail(404, 'Cantiere non trovato', 'NOT_FOUND');
  return p;
}

function touch(projectId, extra = {}) {
  // Ogni modifica a un PSC firmato lo riporta in bozza: la prossima firma è una nuova revisione.
  // Senza await quando non serve aspettare (data di modifica); con dati (layout, computo) si aspetta.
  // .then() fa partire subito la query (i builder di Supabase partono solo quando
  // qualcuno li "aspetta"): chi non ha bisogno di aspettare non la perde.
  return supabase.from('psc_projects').update({ updated_at: new Date().toISOString(), status: 'bozza', ...extra }).eq('id', projectId).neq('status', 'archiviato')
    .then(r => { if (r.error) console.error('[psc touch]', r.error.message); return r; }, e => { console.error('[psc touch]', e && e.message); return { error: e }; });
}

async function full(req, projectId) {
  const all = await store.loadAll(req.companyId, projectId);
  if (!all) throw fail(404, 'Cantiere non trovato', 'NOT_FOUND');
  const st = await store.stato(req.companyId, all);
  return { ...all, ...st };
}

// ── Catalogo ────────────────────────────────────────────────────────────────
router.get('/psc/catalogo', ...auth, h(async (req, res) => {
  res.json({
    schede: L.catalogo(),
    categorieSchede: require('../../lib/lavorazioniSchede').CATEGORIE,
    organizzazione: catalog.ORGANIZZAZIONE.map(o => ({ key: o.key, titolo: o.titolo, rif: o.rif, testo: o.testo })),
    usoComune: catalog.USO_COMUNE.map(u => ({ key: u.key, titolo: u.titolo, testo: u.testo })),
    contesto: Object.fromEntries(Object.entries(catalog.CONTESTO).map(([k, v]) => [k, { titolo: v.titolo, misure: v.misure }])),
    ordigni: catalog.ORDIGNI,
    categorieCosti: catalog.CATEGORIE_COSTI,
    vociCosto: catalog.VOCI_COSTO.map(v => ({ key: v.key, cat: v.cat, descrizione: v.descrizione, um: v.um, prezzo: v.prezzo })),
    pscContenuti: catalog.PSC_CONTENUTI,
    posContenuti: catalog.POS_CONTENUTI,
    testi: catalog.TESTI_PROPOSTI,
  });
}));

// ── Profilo del coordinatore ────────────────────────────────────────────────
router.get('/psc/me', ...auth, h(async (req, res) => {
  const profilo = await store.profiloCse(req.companyId, req.user);
  const { data: c } = await supabase.from('companies').select('trial_ends_at, subscription_status').eq('id', req.companyId).maybeSingle();
  res.json({ profilo, trial_ends_at: c && c.trial_ends_at, subscription_status: c && c.subscription_status });
}));

router.patch('/psc/me', ...auth, h(async (req, res) => {
  const b = pick(req.body, { nome: (v) => str(v, 120), qualifica: (v) => str(v, 120), telefono: (v) => str(v, 40), studio: (v) => str(v, 200) });
  const meta = {};
  if ('nome' in b) meta.full_name = b.nome;
  if ('qualifica' in b) meta.qualifica = b.qualifica;
  if ('telefono' in b) meta.phone = b.telefono;
  if (Object.keys(meta).length) {
    const { data: u } = await supabase.auth.admin.getUserById(req.user.id);
    await supabase.auth.admin.updateUserById(req.user.id, { user_metadata: { ...((u && u.user && u.user.user_metadata) || {}), ...meta } });
  }
  const comp = {};
  if (b.studio) comp.name = b.studio;
  if ('telefono' in b) comp.phone = b.telefono;
  if (Object.keys(comp).length) await supabase.from('companies').update(comp).eq('id', req.companyId);
  res.json({ ok: true, profilo: await store.profiloCse(req.companyId, req.user) });
}));

// ── Oggi: la scrivania del coordinatore ─────────────────────────────────────
router.get('/psc/oggi', ...auth, h(async (req, res) => {
  const { data: projects } = await supabase.from('psc_projects').select('id, title, address, comune, status, revision, start_date, end_date, esempio, updated_at')
    .eq('company_id', req.companyId).is('deleted_at', null).neq('status', 'archiviato').order('updated_at', { ascending: false });
  const ids = (projects || []).map(p => p.id);
  const today = new Date().toISOString().slice(0, 10);
  const [imp, nc, verb, lav, dec] = ids.length ? await Promise.all([
    supabase.from('psc_imprese').select('id, project_id, ragione_sociale, pos_status, pos_due_date, pos_received_at, invited_at').in('project_id', ids),
    supabase.from('psc_nc').select('id, project_id, impresa_id, descrizione, gravita, sospensione, scadenza, status, created_at, closed_reported_at').in('project_id', ids).neq('status', 'chiusa'),
    supabase.from('psc_verbali').select('id, project_id, numero, tipo, data, status').in('project_id', ids).order('data', { ascending: false }).limit(200),
    supabase.from('psc_lavorazioni').select('id, project_id, nome, start_date, end_date, impresa_id, area, scheda_id').in('project_id', ids),
    supabase.from('psc_interferenze').select('lav_a, lav_b, soluzione, project_id').in('project_id', ids),
  ]) : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }, { data: [] }];
  const impById = new Map((imp.data || []).map(i => [i.id, i]));
  const cards = [];
  for (const p of projects || []) {
    const lavP = (lav.data || []).filter(l => l.project_id === p.id);
    const inter = detect(lavP, (dec.data || []).filter(d => d.project_id === p.id));
    const impP = (imp.data || []).filter(i => i.project_id === p.id);
    const ncP = (nc.data || []).filter(n => n.project_id === p.id);
    const inCorso = lavP.filter(l => l.start_date && l.end_date && l.start_date <= today && l.end_date >= today).map(l => l.nome);
    const ultimo = (verb.data || []).find(v => v.project_id === p.id) || null;
    cards.push({
      ...p,
      interferenze_aperte: inter.aperte.length,
      pos: {
        ricevuti: impP.filter(i => i.pos_status === 'ricevuto').length,
        idonei: impP.filter(i => i.pos_status === 'idoneo').length,
        mancanti: impP.filter(i => ['richiesto', 'da_integrare'].includes(i.pos_status)).length,
        totale: impP.length,
      },
      nc_aperte: ncP.length,
      in_corso: inCorso,
      ultimo_verbale: ultimo,
    });
  }
  // Le cose da fare oggi, la più urgente in alto
  const todo = [];
  for (const i of imp.data || []) {
    const p = (projects || []).find(x => x.id === i.project_id);
    if (!p) continue;
    if (i.pos_status === 'ricevuto') todo.push({ tipo: 'pos_da_verificare', urgenza: 1, project_id: p.id, project: p.title, impresa_id: i.id, testo: `POS di ${i.ragione_sociale} da verificare`, quando: i.pos_received_at });
    else if (['richiesto', 'da_integrare'].includes(i.pos_status) && i.pos_due_date && i.pos_due_date < today) todo.push({ tipo: 'pos_in_ritardo', urgenza: 2, project_id: p.id, project: p.title, impresa_id: i.id, testo: `${i.ragione_sociale} non ha ancora consegnato il POS (era atteso il ${new Date(i.pos_due_date).toLocaleDateString('it-IT')})` });
  }
  for (const n of nc.data || []) {
    const p = (projects || []).find(x => x.id === n.project_id);
    if (!p) continue;
    const imp = n.impresa_id ? impById.get(n.impresa_id) : null;
    if (n.status === 'segnalata_chiusa') todo.push({ tipo: 'nc_da_confermare', urgenza: 1, project_id: p.id, project: p.title, nc_id: n.id, testo: `${imp ? imp.ragione_sociale : 'L\'impresa'} dice di aver risolto: ${n.descrizione}`, quando: n.closed_reported_at });
    else if (n.sospensione || (n.scadenza && n.scadenza < today)) todo.push({ tipo: 'nc_aperta', urgenza: n.sospensione ? 0 : 2, project_id: p.id, project: p.title, nc_id: n.id, testo: `${n.sospensione ? 'Lavorazione sospesa' : 'Non conformità scaduta'}: ${n.descrizione}${imp ? ` (${imp.ragione_sociale})` : ''}` });
  }
  for (const c of cards) if (c.interferenze_aperte) todo.push({ tipo: 'interferenze', urgenza: 3, project_id: c.id, project: c.title, testo: `${c.interferenze_aperte === 1 ? '1 interferenza da decidere' : `${c.interferenze_aperte} interferenze da decidere`}` });
  todo.sort((a, b) => a.urgenza - b.urgenza);
  res.json({ cantieri: cards, todo });
}));

// ── Cantieri / PSC ──────────────────────────────────────────────────────────
// Cantiere di esempio: uno per coordinatore, già compilato
router.post('/psc/esempio', ...auth, h(async (req, res) => {
  const { data: ex } = await supabase.from('psc_projects').select('id').eq('company_id', req.companyId).eq('esempio', true).is('deleted_at', null).limit(1);
  if (ex && ex[0]) return res.json({ project: ex[0], esisteva: true });
  const p = await require('../../lib/psc/esempio').creaEsempio(req.companyId, req.user);
  res.status(201).json({ project: { id: p.id } });
}));

router.get('/psc/projects', ...auth, h(async (req, res) => {
  const { data } = await supabase.from('psc_projects').select('id, title, address, comune, status, revision, start_date, end_date, source, esempio, updated_at, created_at')
    .eq('company_id', req.companyId).is('deleted_at', null).order('updated_at', { ascending: false });
  res.json({ projects: data || [] });
}));

router.post('/psc/projects', ...auth, h(async (req, res) => {
  const b = pick(req.body, {
    title: (v) => str(v, 200), address: (v) => str(v, 300), source: (v) => (['indirizzo', 'progetto', 'copia', 'importato'].includes(v) ? v : undefined),
    copy_from: (v) => (isUuid(v) ? v : undefined), start_date: dateOrNull, end_date: dateOrNull,
  });
  if (!b.title || b.title.length < 2) throw fail(400, 'Scrivi il nome del cantiere', 'TITLE_REQUIRED');
  let row;
  if (b.copy_from) {
    const src = await store.loadAll(req.companyId, b.copy_from);
    if (!src) throw fail(404, 'PSC da copiare non trovato', 'NOT_FOUND');
    const s = src.project;
    row = {
      company_id: req.companyId, created_by: req.user.id, title: b.title, source: 'copia', copied_from: s.id,
      address: b.address || null, start_date: b.start_date || null, end_date: b.end_date || null,
      descrizione: s.descrizione, tipo_opera: s.tipo_opera,
      soggetti: { cse: (s.soggetti || {}).cse, csp: (s.soggetti || {}).csp },
      organizzazione: s.organizzazione, uso_comune: s.uso_comune, emergenze: { ...s.emergenze, pronto_soccorso: null }, coordinamento: s.coordinamento,
      procedure: s.procedure, testi: s.testi,
    };
    const { data: np, error } = await supabase.from('psc_projects').insert(row).select('*').single();
    if (error) throw error;
    // Lavorazioni senza date, imprese e decisioni: quelle sono di ogni cantiere.
    if (src.lavorazioni.length) {
      const lavRows = src.lavorazioni.map((l, i) => ({
        project_id: np.id, company_id: req.companyId, ordine: i, nome: l.nome, descrizione: l.descrizione, scheda_id: l.scheda_id,
        fasi: l.fasi, rischi: l.rischi, misure: (l.misure || []).map(m => ({ ...m, approvata: false, fonte: m.fonte === 'palladia' ? 'palladia' : 'mia', fonte_nome: m.fonte_nome || `PSC ${s.title}` })),
        dpi: l.dpi, apprestamenti: l.apprestamenti, addetti: l.addetti, uomini_giorno: l.uomini_giorno,
      }));
      await supabase.from('psc_lavorazioni').insert(lavRows);
    }
    if (src.costi.length) {
      await supabase.from('psc_costi').insert(src.costi.map((c, i) => ({
        project_id: np.id, company_id: req.companyId, ordine: i, categoria: c.categoria, codice: c.codice, descrizione: c.descrizione, um: c.um,
        quantita: 0, prezzo: c.prezzo, prezzo_fonte: c.prezzo_fonte === 'indicativo' ? 'indicativo' : 'libreria', origine: c.origine,
      })));
    }
    return res.status(201).json({ project: np });
  }
  const def = await store.defaults(req.companyId, req.user);
  row = { company_id: req.companyId, created_by: req.user.id, title: b.title, source: b.source || 'indirizzo', address: b.address || null, start_date: b.start_date || null, end_date: b.end_date || null, ...def };
  const { data: np, error } = await supabase.from('psc_projects').insert(row).select('*').single();
  if (error) throw error;
  res.status(201).json({ project: np });
}));

router.get('/psc/projects/:id', ...auth, h(async (req, res) => {
  res.json(await full(req, req.params.id));
}));

const PROJECT_FIELDS = {
  title: (v) => str(v, 200), address: (v) => str(v, 300), comune: (v) => str(v, 120), provincia: (v) => str(v, 60),
  descrizione: (v) => str(v, 6000), tipo_opera: (v) => str(v, 200), start_date: dateOrNull, end_date: dateOrNull,
  importo_lavori: (v) => numOrNull(v, 0, 1e11),
  soggetti: jsonOf, contesto: jsonOf, organizzazione: jsonOf, emergenze: jsonOf, coordinamento: jsonOf, testi: jsonOf,
  uso_comune: (v) => (Array.isArray(v) ? jsonOf(v) : undefined), procedure: (v) => (Array.isArray(v) ? jsonOf(v) : undefined),
};

router.patch('/psc/projects/:id', ...auth, h(async (req, res) => {
  const p = await mustProject(req);
  const b = pick(req.body, PROJECT_FIELDS);
  if ('title' in b && (!b.title || b.title.length < 2)) throw fail(400, 'Il nome del cantiere non può essere vuoto');
  const sd = 'start_date' in b ? b.start_date : p.start_date, ed = 'end_date' in b ? b.end_date : p.end_date;
  if (sd && ed && ed < sd) throw fail(400, 'La fine lavori è prima dell\'inizio', 'DATE_ORDER');
  if ('address' in b && b.address !== p.address) b.contesto = { ...(b.contesto || p.contesto || {}), analizzato: false };
  const { data, error } = await supabase.from('psc_projects').update({ ...b, updated_at: new Date().toISOString(), status: p.status === 'archiviato' ? 'archiviato' : 'bozza' }).eq('id', p.id).select('*').single();
  if (error) throw error;
  res.json({ project: data });
}));

router.delete('/psc/projects/:id', ...auth, h(async (req, res) => {
  const p = await mustProject(req);
  await supabase.from('psc_projects').update({ deleted_at: new Date().toISOString() }).eq('id', p.id);
  res.json({ ok: true });
}));

router.post('/psc/projects/:id/archivia', ...auth, h(async (req, res) => {
  const p = await mustProject(req);
  const to = req.body && req.body.riapri ? 'bozza' : 'archiviato';
  await supabase.from('psc_projects').update({ status: to }).eq('id', p.id);
  res.json({ ok: true, status: to });
}));

// ── Contesto da OpenStreetMap ───────────────────────────────────────────────
router.post('/psc/projects/:id/contesto', ...auth, h(async (req, res) => {
  const p = await mustProject(req);
  const address = require('../../lib/psc/documento').luogo(p.address, p.comune);
  if (!p.address || p.address.length < 5) throw fail(400, 'Scrivi prima l\'indirizzo del cantiere', 'ADDRESS_REQUIRED');
  let r;
  try { r = await contesto.analizza(address, { prev: p.contesto || {} }); }
  catch (e) { throw fail(503, 'Il servizio delle mappe non risponde. Riprova tra poco.', 'MAP_UNAVAILABLE'); }
  if (!r.ok) throw fail(422, 'Non trovo questo indirizzo sulla mappa. Controlla via, numero e comune.', 'ADDRESS_NOT_FOUND');
  // Le scelte già fatte (voci spente, misure riscritte) restano.
  const prevTrovati = new Map(((p.contesto || {}).trovati || []).map(t => [t.key, t]));
  r.contesto.trovati = r.contesto.trovati.map(t => (prevTrovati.has(t.key) ? { ...t, attivo: prevTrovati.get(t.key).attivo, misure_testo: prevTrovati.get(t.key).misure_testo } : t));
  const emergenze = { ...(p.emergenze || {}) };
  if (r.pronto_soccorso && !(emergenze.pronto_soccorso && emergenze.pronto_soccorso.manuale)) emergenze.pronto_soccorso = r.pronto_soccorso;
  const upd = { contesto: { ...(p.contesto || {}), ...r.contesto }, lat: r.lat, lon: r.lon, emergenze, updated_at: new Date().toISOString() };
  if (!p.comune && r.comune) upd.comune = r.comune;
  if (!p.provincia && r.provincia) upd.provincia = r.provincia;
  const { data } = await supabase.from('psc_projects').update(upd).eq('id', p.id).select('*').single();
  res.json({ project: data });
}));

// ── Layout di cantiere ──────────────────────────────────────────────────────
router.post('/psc/projects/:id/layout', ...auth, upLayout('file'), h(async (req, res) => {
  const p = await mustProject(req);
  if (!req.file) throw fail(400, 'Scegli un file', 'FILE_REQUIRED');
  const ext = isPdf(req.file) ? 'pdf' : (req.file.mimetype.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const path = `${req.companyId}/${p.id}/layout-${Date.now()}.${ext}`;
  await store.upload(path, req.file.buffer, req.file.mimetype);
  await touch(p.id, { layout_path: path, layout_name: req.file.originalname.slice(0, 200) });
  res.json({ ok: true, layout_name: req.file.originalname });
}));
router.get('/psc/projects/:id/layout', ...auth, h(async (req, res) => {
  const p = await mustProject(req);
  if (!p.layout_path) throw fail(404, 'Nessun layout', 'NOT_FOUND');
  res.json({ url: await store.signedUrl(p.layout_path, 600), name: p.layout_name });
}));
router.delete('/psc/projects/:id/layout', ...auth, h(async (req, res) => {
  const p = await mustProject(req);
  await touch(p.id, { layout_path: null, layout_name: null });
  res.json({ ok: true });
}));

// ── Computo → lavorazioni ───────────────────────────────────────────────────
router.post('/psc/projects/:id/computo', ...auth, aiLimiter, upComputo('file'), h(async (req, res) => {
  const p = await mustProject(req);
  if (!req.file) throw fail(400, 'Scegli il file del computo', 'FILE_REQUIRED');
  const name = req.file.originalname || '';
  let parsed;
  try {
    if (/\.(xpwe|xml)$/i.test(name)) parsed = parseXpwe(req.file.buffer);
    else if (isPdf(req.file)) parsed = await parsePdf(req.file.buffer, req.companyId, req.user.id);
    else parsed = await parseExcel(req.file.buffer, req.companyId, req.user.id);
  } catch (e) {
    // F-281: il lettore del computo spiega già cosa non va ("Nessuna voce trovata…"),
    // ma senza codice di stato diventava 500 "Qualcosa non ha funzionato".
    if (e && e.status) throw e;
    console.error('[psc computo] non letto:', e && e.message);
    const leggibile = e && typeof e.message === 'string' && /voc[ei]|computo|documento|file/i.test(e.message);
    throw fail(422, leggibile ? e.message : 'Non riesco a leggere questo file. Prova con il computo in PDF, Excel o XPWE (Primus).', 'COMPUTO_NON_LETTO');
  }
  // computoParser restituisce anche le righe "categoria": portiamo il nome sulla voce.
  let cat = null;
  const voci = [];
  for (const v of parsed.voci || []) {
    if (v.tipo === 'categoria') { cat = v.descrizione; continue; }
    voci.push({ ...v, categoria: v.categoria || cat });
  }
  if (!voci.length) throw fail(422, 'Nel file non ho trovato voci di computo', 'NO_VOCI');
  const lib = await store.library(req.companyId, ['misura']);
  const start = p.start_date || new Date().toISOString().slice(0, 10);
  const lavs = L.fromComputo(voci, { start, library: lib });
  const { count } = await supabase.from('psc_lavorazioni').select('id', { count: 'exact', head: true }).eq('project_id', p.id);
  const rows = lavs.map((l, i) => ({
    project_id: p.id, company_id: req.companyId, ordine: (count || 0) + i, nome: l.nome, descrizione: l.descrizione, scheda_id: l.scheda_id,
    fasi: l.fasi, rischi: l.rischi, misure: l.misure, dpi: l.dpi, apprestamenti: l.apprestamenti, voci_computo: l.voci_computo,
    uomini_giorno: l.uomini_giorno, addetti: l.addetti, start_date: l.start_date, end_date: l.end_date,
  }));
  const { error } = await supabase.from('psc_lavorazioni').insert(rows);
  if (error) throw error;
  const totale = voci.reduce((s, v) => s + (Number(v.importo) || 0), 0);
  const upd = { computo: { nome: parsed.nome || name, file: name, voci: voci.length, lavorazioni: rows.length, totale: Math.round(totale * 100) / 100, letto_at: new Date().toISOString() }, source: p.source || 'progetto' };
  if (!p.importo_lavori && totale > 0) upd.importo_lavori = Math.round(totale * 100) / 100;
  if (!p.end_date) upd.end_date = rows.map(r => r.end_date).filter(Boolean).sort().reverse()[0] || null;
  if (!p.start_date) upd.start_date = start;
  await touch(p.id, upd);
  res.json({ ok: true, voci: voci.length, lavorazioni: rows.length, totale: upd.computo.totale });
}));

// ── Lavorazioni ─────────────────────────────────────────────────────────────
async function mustLav(req) {
  if (!isUuid(req.params.lid)) throw fail(404, 'Lavorazione non trovata', 'NOT_FOUND');
  const { data } = await supabase.from('psc_lavorazioni').select('*').eq('id', req.params.lid).eq('company_id', req.companyId).maybeSingle();
  if (!data) throw fail(404, 'Lavorazione non trovata', 'NOT_FOUND');
  return data;
}

router.post('/psc/projects/:id/lavorazioni', ...auth, h(async (req, res) => {
  const p = await mustProject(req);
  const b = pick(req.body, { scheda_id: (v) => str(v, 80), nome: (v) => str(v, 200) });
  const lib = await store.library(req.companyId, ['misura']);
  const base = b.scheda_id ? L.fromScheda(b.scheda_id, { library: lib, nome: b.nome || undefined }) : null;
  if (b.scheda_id && !base) throw fail(400, 'Lavorazione sconosciuta', 'BAD_SCHEDA');
  if (!base && !b.nome) throw fail(400, 'Scrivi il nome della lavorazione', 'NAME_REQUIRED');
  const { data: last } = await supabase.from('psc_lavorazioni').select('ordine, end_date').eq('project_id', p.id).order('ordine', { ascending: false }).limit(1);
  const ordine = last && last[0] ? last[0].ordine + 1 : 0;
  const start = (last && last[0] && last[0].end_date) ? L.addWorkdays(last[0].end_date, 2) : p.start_date || null;
  const row = {
    project_id: p.id, company_id: req.companyId, ordine, ...(base || L.libera(b.nome)),
    start_date: start, end_date: start ? L.addWorkdays(start, 10) : null, addetti: 3, uomini_giorno: start ? 30 : null,
  };
  const { data, error } = await supabase.from('psc_lavorazioni').insert(row).select('*').single();
  if (error) throw error;
  touch(p.id);
  res.status(201).json({ lavorazione: data });
}));

const MISURA = (m) => (m && typeof m.testo === 'string' && m.testo.trim()
  ? { id: str(m.id, 40) || L.rid(), testo: m.testo.trim().slice(0, 1200), fonte: ['palladia', 'mia', 'manuale'].includes(m.fonte) ? m.fonte : 'manuale', fonte_nome: str(m.fonte_nome, 200) || null, library_id: isUuid(m.library_id) ? m.library_id : null, approvata: m.approvata === true }
  : null);
const RISCHIO = (r) => {
  if (!r || typeof r.testo !== 'string' || !r.testo.trim()) return null;
  const P = Math.min(4, Math.max(1, Number(r.p) || 1)), D = Math.min(4, Math.max(1, Number(r.d) || 1));
  const R = P * D;
  return { id: str(r.id, 40) || L.rid(), testo: r.testo.trim().slice(0, 400), p: P, d: D, r: R, livello: require('../../lib/lavorazioniSchede').livello(R), fonte: ['palladia', 'mia', 'manuale'].includes(r.fonte) ? r.fonte : 'manuale' };
};

router.patch('/psc/lavorazioni/:lid', ...auth, h(async (req, res) => {
  const l = await mustLav(req);
  const b = pick(req.body, {
    nome: (v) => str(v, 200), descrizione: (v) => str(v, 4000), area: (v) => str(v, 120),
    impresa_id: (v) => (v === null || isUuid(v) ? v : undefined), start_date: dateOrNull, end_date: dateOrNull,
    addetti: (v) => numOrNull(v, 0, 500), uomini_giorno: (v) => numOrNull(v, 0, 100000), ordine: (v) => numOrNull(v, 0, 10000),
    fasi: (v) => (Array.isArray(v) ? v.map(x => str(x, 300)).filter(Boolean).slice(0, 30) : undefined),
    dpi: (v) => (Array.isArray(v) ? v.map(x => str(x, 200)).filter(Boolean).slice(0, 30) : undefined),
    apprestamenti: (v) => (Array.isArray(v) ? v.filter(x => x && x.nome).map(x => ({ nome: str(x.nome, 200), verifica: str(x.verifica, 300) || null })).slice(0, 30) : undefined),
    misure: (v) => (Array.isArray(v) ? v.map(MISURA).filter(Boolean).slice(0, 60) : undefined),
    rischi: (v) => (Array.isArray(v) ? v.map(RISCHIO).filter(Boolean).slice(0, 40) : undefined),
  });
  if ('nome' in b && !b.nome) throw fail(400, 'Il nome non può essere vuoto');
  const sd = 'start_date' in b ? b.start_date : l.start_date, ed = 'end_date' in b ? b.end_date : l.end_date;
  if (sd && ed && ed < sd) throw fail(400, 'La fine è prima dell\'inizio', 'DATE_ORDER');
  if (b.impresa_id) {
    const { data: imp } = await supabase.from('psc_imprese').select('id').eq('id', b.impresa_id).eq('project_id', l.project_id).maybeSingle();
    if (!imp) throw fail(400, 'Impresa non di questo cantiere');
  }
  const { data, error } = await supabase.from('psc_lavorazioni').update({ ...b, updated_at: new Date().toISOString() }).eq('id', l.id).select('*').single();
  if (error) throw error;
  touch(l.project_id);
  res.json({ lavorazione: data });
}));

router.post('/psc/lavorazioni/:lid/approva-tutte', ...auth, h(async (req, res) => {
  const l = await mustLav(req);
  const misure = (l.misure || []).map(m => ({ ...m, approvata: true }));
  const { data } = await supabase.from('psc_lavorazioni').update({ misure, updated_at: new Date().toISOString() }).eq('id', l.id).select('*').single();
  touch(l.project_id);
  res.json({ lavorazione: data });
}));

router.delete('/psc/lavorazioni/:lid', ...auth, h(async (req, res) => {
  const l = await mustLav(req);
  await supabase.from('psc_lavorazioni').delete().eq('id', l.id);
  touch(l.project_id);
  res.json({ ok: true });
}));

// Misure della libreria per una lavorazione (pannello "Le tue frasi")
router.get('/psc/lavorazioni/:lid/suggerimenti', ...auth, h(async (req, res) => {
  const l = await mustLav(req);
  const lib = await store.library(req.companyId, ['misura']);
  const presenti = new Set((l.misure || []).map(m => m.testo.toLowerCase().slice(0, 60)));
  const mie = lib.filter(x => (l.scheda_id ? x.scheda_id === l.scheda_id : false) && !presenti.has(x.testo.toLowerCase().slice(0, 60)))
    .sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, 30)
    .map(x => ({ testo: x.testo, fonte: 'mia', fonte_nome: x.source_name, library_id: x.id }));
  const scheda = l.scheda_id ? require('../../lib/lavorazioniSchede').getScheda(l.scheda_id) : null;
  const proposte = (scheda ? scheda.misure : []).filter(t => !presenti.has(t.toLowerCase().slice(0, 60))).map(t => ({ testo: t, fonte: 'palladia' }));
  res.json({ mie, proposte });
}));

// ── Interferenze ────────────────────────────────────────────────────────────
router.get('/psc/projects/:id/interferenze', ...auth, h(async (req, res) => {
  const all = await store.loadAll(req.companyId, req.params.id);
  if (!all) throw fail(404, 'Cantiere non trovato', 'NOT_FOUND');
  const inter = detect(all.lavorazioni, all.decisioni);
  const lavById = new Map(all.lavorazioni.map(l => [l.id, l]));
  const impById = new Map(all.imprese.map(i => [i.id, i]));
  res.json({
    aperte: inter.aperte.map(x => ({ ...x, ...soluzioni(x, lavById, impById, all.project.end_date) })),
    risolte: inter.risolte,
  });
}));

router.post('/psc/projects/:id/interferenze', ...auth, h(async (req, res) => {
  const all = await store.loadAll(req.companyId, req.params.id);
  if (!all) throw fail(404, 'Cantiere non trovato', 'NOT_FOUND');
  const b = pick(req.body, { lav_a: (v) => (isUuid(v) ? v : undefined), lav_b: (v) => (isUuid(v) ? v : undefined), soluzione: (v) => (['temporale', 'spaziale', 'misure'].includes(v) ? v : undefined), testo: (v) => str(v, 3000) });
  if (!b.lav_a || !b.lav_b || !b.soluzione) throw fail(400, 'Dati mancanti');
  const lavById = new Map(all.lavorazioni.map(l => [l.id, l]));
  if (!lavById.has(b.lav_a) || !lavById.has(b.lav_b)) throw fail(404, 'Lavorazione non trovata');
  const inter = detect(all.lavorazioni, all.decisioni).aperte.find(x => x.key === pairKey(b.lav_a, b.lav_b));
  if (!inter) throw fail(409, 'Questa interferenza non c\'è più: il cronoprogramma è cambiato', 'GONE');
  const sol = soluzioni(inter, lavById, new Map(all.imprese.map(i => [i.id, i])), all.project.end_date);
  const scelta = sol.opzioni.find(o => o.soluzione === b.soluzione);
  if (b.soluzione === 'temporale') {
    await supabase.from('psc_lavorazioni').update({ start_date: scelta.sposta.start_date, end_date: scelta.sposta.end_date, updated_at: new Date().toISOString() }).eq('id', scelta.sposta.lavorazione_id).eq('company_id', req.companyId);
  }
  const [a, z] = b.lav_a < b.lav_b ? [b.lav_a, b.lav_b] : [b.lav_b, b.lav_a];
  const { error } = await supabase.from('psc_interferenze').upsert({
    project_id: all.project.id, company_id: req.companyId, lav_a: a, lav_b: z, soluzione: b.soluzione,
    testo: b.testo || scelta.testo, rischio: sol.rischio, decided_by: req.user.id, decided_at: new Date().toISOString(),
  }, { onConflict: 'project_id,lav_a,lav_b' });
  if (error) throw error;
  touch(all.project.id);
  res.json(await full(req, all.project.id));
}));

router.delete('/psc/interferenze/:iid', ...auth, h(async (req, res) => {
  if (!isUuid(req.params.iid)) throw fail(404, 'Non trovata');
  const { data } = await supabase.from('psc_interferenze').delete().eq('id', req.params.iid).eq('company_id', req.companyId).select('project_id');
  if (!data || !data.length) throw fail(404, 'Non trovata');
  touch(data[0].project_id);
  res.json({ ok: true });
}));

// ── Costi della sicurezza ───────────────────────────────────────────────────
router.post('/psc/projects/:id/costi/proponi', ...auth, h(async (req, res) => {
  const all = await store.loadAll(req.companyId, req.params.id);
  if (!all) throw fail(404, 'Cantiere non trovato', 'NOT_FOUND');
  const lib = await store.library(req.companyId, ['costo']);
  const rows = costiLib.proponi({
    project: all.project, lavorazioni: all.lavorazioni, contestoKeys: contesto.chiaviAttive(all.project.contesto),
    decisioni: all.decisioni, nImprese: all.imprese.length, library: lib, esistenti: all.costi,
  }).map(r => ({ ...r, project_id: all.project.id, company_id: req.companyId }));
  if (rows.length) { const { error } = await supabase.from('psc_costi').insert(rows); if (error) throw error; touch(all.project.id); }
  res.json({ aggiunte: rows.length, ...(await full(req, all.project.id)) });
}));

const COSTO_FIELDS = {
  categoria: (v) => (Object.keys(catalog.CATEGORIE_COSTI).includes(v) ? v : undefined), codice: (v) => str(v, 60), descrizione: (v) => str(v, 1200), um: (v) => str(v, 20),
  quantita: (v) => numOrNull(v, 0, 1e8), prezzo: (v) => numOrNull(v, 0, 1e8), impresa_id: (v) => (v === null || isUuid(v) ? v : undefined),
  lavorazione_id: (v) => (v === null || isUuid(v) ? v : undefined), ordine: (v) => numOrNull(v, 0, 10000),
};

router.post('/psc/projects/:id/costi', ...auth, h(async (req, res) => {
  const p = await mustProject(req);
  const b = pick(req.body, { ...COSTO_FIELDS, catalog_key: (v) => str(v, 60), library_id: (v) => (isUuid(v) ? v : undefined) });
  let row = { categoria: b.categoria || 'a', descrizione: b.descrizione, um: b.um || null, quantita: b.quantita || 0, prezzo: b.prezzo || 0, codice: b.codice || null, impresa_id: b.impresa_id || null, prezzo_fonte: 'manuale' };
  if (b.catalog_key) {
    const v = catalog.VOCI_COSTO.find(x => x.key === b.catalog_key);
    if (!v) throw fail(400, 'Voce sconosciuta');
    row = { ...row, categoria: v.cat, descrizione: v.descrizione, um: v.um, prezzo: v.prezzo, prezzo_fonte: 'indicativo', origine: `catalogo:${v.key}` };
  } else if (b.library_id) {
    const { data: lb } = await supabase.from('psc_library').select('*').eq('id', b.library_id).eq('company_id', req.companyId).maybeSingle();
    if (!lb) throw fail(404, 'Voce non trovata');
    row = { ...row, descrizione: lb.testo, um: lb.data.um || row.um, prezzo: Number(lb.data.prezzo) || 0, codice: lb.data.codice || null, prezzo_fonte: 'libreria', origine: lb.data.key ? `catalogo:${lb.data.key}` : null };
  }
  if (!row.descrizione) throw fail(400, 'Scrivi la descrizione della voce');
  const { count } = await supabase.from('psc_costi').select('id', { count: 'exact', head: true }).eq('project_id', p.id);
  const { data, error } = await supabase.from('psc_costi').insert({ ...row, ordine: count || 0, project_id: p.id, company_id: req.companyId }).select('*').single();
  if (error) throw error;
  touch(p.id);
  res.status(201).json({ costo: data });
}));

router.patch('/psc/costi/:cid', ...auth, h(async (req, res) => {
  if (!isUuid(req.params.cid)) throw fail(404, 'Non trovata');
  const { data: c } = await supabase.from('psc_costi').select('*').eq('id', req.params.cid).eq('company_id', req.companyId).maybeSingle();
  if (!c) throw fail(404, 'Voce non trovata');
  const b = pick(req.body, { ...COSTO_FIELDS, conferma_prezzo: (v) => (v === true ? true : undefined) });
  const upd = { ...b };
  delete upd.conferma_prezzo;
  if (('prezzo' in b && Number(b.prezzo) !== Number(c.prezzo)) || b.conferma_prezzo) upd.prezzo_fonte = 'manuale';
  const { data, error } = await supabase.from('psc_costi').update(upd).eq('id', c.id).select('*').single();
  if (error) throw error;
  touch(c.project_id);
  res.json({ costo: data });
}));

router.delete('/psc/costi/:cid', ...auth, h(async (req, res) => {
  if (!isUuid(req.params.cid)) throw fail(404, 'Non trovata');
  const { data } = await supabase.from('psc_costi').delete().eq('id', req.params.cid).eq('company_id', req.companyId).select('project_id');
  if (!data || !data.length) throw fail(404, 'Voce non trovata');
  touch(data[0].project_id);
  res.json({ ok: true });
}));

router.get('/psc/costi/cerca', ...auth, h(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const lib = (await store.library(req.companyId, ['costo'])).filter(x => !q || x.testo.toLowerCase().includes(q)).slice(0, 25)
    .map(x => ({ library_id: x.id, descrizione: x.testo, um: x.data.um, prezzo: x.data.prezzo, codice: x.data.codice, fonte_nome: x.source_name }));
  const cat = catalog.VOCI_COSTO.filter(v => !q || v.descrizione.toLowerCase().includes(q)).slice(0, 25)
    .map(v => ({ catalog_key: v.key, descrizione: v.descrizione, um: v.um, prezzo: v.prezzo, categoria: v.cat }));
  res.json({ mie: lib, catalogo: cat });
}));

// ── Documenti ───────────────────────────────────────────────────────────────
function sendPdf(res, buf, name, inline) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName(name)}.pdf"`);
  res.send(buf);
}

router.get('/psc/projects/:id/pdf', ...auth, h(async (req, res) => {
  const all = await store.loadAll(req.companyId, req.params.id);
  if (!all) throw fail(404, 'Cantiere non trovato', 'NOT_FOUND');
  const buf = await store.renderPsc(all);
  sendPdf(res, buf, `PSC ${all.project.title} bozza`, req.query.inline === '1');
}));

router.get('/psc/projects/:id/word', ...auth, h(async (req, res) => {
  const all = await store.loadAll(req.companyId, req.params.id);
  if (!all) throw fail(404, 'Cantiere non trovato', 'NOT_FOUND');
  res.setHeader('Content-Type', 'application/msword; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(`PSC ${all.project.title}`)}.doc"`);
  res.send(String.fromCharCode(0xFEFF) + documento.pscWord(all)); // BOM: Word riconosce l'UTF-8
}));

router.get('/psc/projects/:id/fascicolo', ...auth, h(async (req, res) => {
  const all = await store.loadAll(req.companyId, req.params.id);
  if (!all) throw fail(404, 'Cantiere non trovato', 'NOT_FOUND');
  const { rendererPool } = require('../../pdf-renderer');
  const buf = await rendererPool.render(documento.fascicoloHtml(all), { docTitle: `Fascicolo dell'opera · ${all.project.title}`, headerLeft: ((all.project.soggetti || {}).cse || {}).studio || 'Fascicolo', footerLeft: 'D.Lgs. 81/2008 · Allegato XVI', revision: '0' });
  sendPdf(res, buf, `Fascicolo ${all.project.title}`, req.query.inline === '1');
}));

router.get('/psc/projects/:id/notifica', ...auth, h(async (req, res) => {
  const all = await store.loadAll(req.companyId, req.params.id);
  if (!all) throw fail(404, 'Cantiere non trovato', 'NOT_FOUND');
  if (req.query.format === 'json') return res.json({ righe: documento.notificaDati(all) });
  const { rendererPool } = require('../../pdf-renderer');
  const buf = await rendererPool.render(documento.notificaHtml(all), { docTitle: `Notifica preliminare · ${all.project.title}`, headerLeft: ((all.project.soggetti || {}).cse || {}).studio || 'Notifica', footerLeft: 'D.Lgs. 81/2008 · art. 99', revision: '0' });
  sendPdf(res, buf, `Notifica preliminare ${all.project.title}`, req.query.inline === '1');
}));

// ── Firma: nuova revisione ──────────────────────────────────────────────────
router.post('/psc/projects/:id/firma', ...auth, h(async (req, res) => {
  const all = await store.loadAll(req.companyId, req.params.id);
  if (!all) throw fail(404, 'Cantiere non trovato', 'NOT_FOUND');
  const b = pick(req.body, { motivo: (v) => str(v, 300), firmatario: (v) => str(v, 160) });
  const st = await store.stato(req.companyId, all);
  const p = all.project;
  const nextRev = all.revisioni.length ? Math.max(...all.revisioni.map(r => r.revision)) + 1 : 0;
  const motivo = b.motivo || (nextRev === 0 ? 'Prima emissione' : 'Aggiornamento');
  const signedAt = new Date().toISOString();
  const projForPdf = { ...p, revision: nextRev, signed_at: signedAt };
  const revisioni = [...all.revisioni, { revision: nextRev, motivo, created_at: signedAt }];
  const pdf = await store.renderPsc({ ...all, project: projForPdf, revisioni });
  const path = `${req.companyId}/${p.id}/PSC-rev${nextRev}-${Date.now()}.pdf`;
  await store.upload(path, pdf, 'application/pdf');
  const snapshot = { project: projForPdf, lavorazioni: all.lavorazioni, imprese: all.imprese, costi: all.costi, decisioni: all.decisioni };
  const { data: rev, error } = await supabase.from('psc_revisions').insert({
    project_id: p.id, company_id: req.companyId, revision: nextRev, motivo, snapshot, pdf_path: path,
    signer: b.firmatario || ((p.soggetti || {}).cse || {}).nome || null,
    open_points: st.controllo.aperti, created_by: req.user.id,
  }).select('*').single();
  if (error) throw error;
  await supabase.from('psc_projects').update({ status: 'firmato', revision: nextRev, signed_at: signedAt, signed_by: rev.signer, updated_at: signedAt }).eq('id', p.id);

  // La libreria impara: le misure scritte o riscritte dal coordinatore e approvate
  // diventano sue; quelle già sue contano un uso in più.
  const learn = [];
  const sourceName = `PSC ${p.title} rev. ${nextRev}`.slice(0, 160);
  const used = [];
  for (const l of all.lavorazioni) for (const m of l.misure || []) {
    if (!m.approvata) continue;
    if (m.fonte === 'manuale') learn.push({ company_id: req.companyId, kind: 'misura', scheda_id: l.scheda_id, titolo: l.nome, testo: m.testo, source_name: sourceName, source_project: p.id });
    if (m.library_id) used.push(m.library_id);
  }
  const org = p.organizzazione || {};
  for (const [, v] of Object.entries(org)) if (v && v.attivo !== false && v.fonte === 'manuale' && v.testo) learn.push({ company_id: req.companyId, kind: 'frase', sezione: 'organizzazione', titolo: v.titolo || null, testo: v.testo, source_name: sourceName, source_project: p.id });
  const coord = p.coordinamento || {};
  if (coord.riunioni && coord.riunioni_fonte && coord.riunioni_fonte.fonte === 'manuale') learn.push({ company_id: req.companyId, kind: 'frase', sezione: 'coordinamento', titolo: 'Riunioni di coordinamento', testo: coord.riunioni, source_name: sourceName, source_project: p.id });
  for (const c of all.costi) if (c.prezzo_fonte === 'manuale' && Number(c.prezzo) > 0) learn.push({ company_id: req.companyId, kind: 'costo', testo: c.descrizione, data: { key: c.origine && c.origine.startsWith('catalogo:') ? c.origine.slice(9) : null, um: c.um, prezzo: Number(c.prezzo), codice: c.codice }, source_name: sourceName, source_project: p.id });
  for (const row of learn) { const { error: e } = await supabase.from('psc_library').insert(row); if (e && e.code !== '23505') console.error('[psc learn]', e.message); }
  for (const id of used) {
    const { data: lb } = await supabase.from('psc_library').select('uses').eq('id', id).eq('company_id', req.companyId).maybeSingle();
    if (lb) await supabase.from('psc_library').update({ uses: (lb.uses || 0) + 1, last_used_at: signedAt }).eq('id', id);
  }
  res.json({ revisione: { id: rev.id, revision: rev.revision, motivo: rev.motivo, created_at: rev.created_at }, imparate: learn.length });
}));

router.get('/psc/revisions/:rid/pdf', ...auth, h(async (req, res) => {
  if (!isUuid(req.params.rid)) throw fail(404, 'Non trovata');
  const { data: r } = await supabase.from('psc_revisions').select('pdf_path, signed_path, signed_name, revision, project_id').eq('id', req.params.rid).eq('company_id', req.companyId).maybeSingle();
  if (!r) throw fail(404, 'Revisione non trovata');
  const which = req.query.firmato === '1' ? r.signed_path : r.pdf_path;
  if (!which) throw fail(404, 'File non presente');
  res.json({ url: await store.signedUrl(which, 600, req.query.firmato === '1' ? r.signed_name : `PSC-rev${r.revision}.pdf`) });
}));

router.post('/psc/revisions/:rid/firmato', ...auth, upSigned('file'), h(async (req, res) => {
  if (!isUuid(req.params.rid)) throw fail(404, 'Non trovata');
  const { data: r } = await supabase.from('psc_revisions').select('id, project_id, revision').eq('id', req.params.rid).eq('company_id', req.companyId).maybeSingle();
  if (!r) throw fail(404, 'Revisione non trovata');
  if (!req.file) throw fail(400, 'Scegli il file firmato');
  const info = riconosci(req.file.buffer, req.file.originalname);
  if (!info) throw fail(422, 'In questo file non trovo una firma digitale. Carica il PDF firmato (PAdES) o il file .p7m (CAdES).', 'NO_SIGNATURE');
  const ext = /\.p7m$/i.test(req.file.originalname) ? 'pdf.p7m' : 'pdf';
  const path = `${req.companyId}/${r.project_id}/PSC-rev${r.revision}-firmato-${Date.now()}.${ext}`;
  await store.upload(path, req.file.buffer, ext === 'pdf' ? 'application/pdf' : 'application/pkcs7-mime');
  const firmatario = (info.firmatari.find(f => f.nome) || {}).nome || null;
  await supabase.from('psc_revisions').update({ signed_path: path, signed_name: req.file.originalname.slice(0, 200), signer: firmatario || undefined }).eq('id', r.id);
  res.json({ ok: true, firma: info.tipo, firmatari: info.firmatari });
}));

// ── Libreria ────────────────────────────────────────────────────────────────
router.get('/psc/libreria', ...auth, h(async (req, res) => {
  const kind = ['misura', 'frase', 'lavorazione', 'costo'].includes(req.query.kind) ? req.query.kind : null;
  const q = String(req.query.q || '').trim().toLowerCase();
  const lib = await store.library(req.companyId);
  const counts = { misura: 0, frase: 0, lavorazione: 0, costo: 0 };
  for (const x of lib) counts[x.kind]++;
  const items = lib.filter(x => (!kind || x.kind === kind) && (!q || `${x.titolo || ''} ${x.testo}`.toLowerCase().includes(q)))
    .sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, 300);
  const { data: imports } = await supabase.from('psc_imports').select('id, file_name, status, num_pages, result, error, created_at, done_at').eq('company_id', req.companyId).order('created_at', { ascending: false }).limit(200);
  res.json({ counts, items, imports: imports || [] });
}));

router.patch('/psc/libreria/:lid', ...auth, h(async (req, res) => {
  if (!isUuid(req.params.lid)) throw fail(404, 'Non trovata');
  const b = pick(req.body, { testo: (v) => str(v, 2000), sezione: (v) => str(v, 40), titolo: (v) => str(v, 200) });
  if ('testo' in b && (!b.testo || b.testo.length < 5)) throw fail(400, 'Testo troppo corto');
  const { data, error } = await supabase.from('psc_library').update(b).eq('id', req.params.lid).eq('company_id', req.companyId).select('*').maybeSingle();
  if (error && error.code === '23505') throw fail(409, 'Hai già questa frase in libreria');
  if (error) throw error;
  if (!data) throw fail(404, 'Non trovata');
  res.json({ item: data });
}));

router.delete('/psc/libreria/:lid', ...auth, h(async (req, res) => {
  if (!isUuid(req.params.lid)) throw fail(404, 'Non trovata');
  await supabase.from('psc_library').delete().eq('id', req.params.lid).eq('company_id', req.companyId);
  res.json({ ok: true });
}));

router.post('/psc/imports', ...auth, aiLimiter, upDocs('files', true), h(async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw fail(400, 'Scegli uno o più file', 'FILE_REQUIRED');
  const created = [];
  for (const f of files) {
    const mime = /\.docx$/i.test(f.originalname) ? DOCX : 'application/pdf';
    const path = `${req.companyId}/libreria/${Date.now()}-${safeName(f.originalname)}`;
    await store.upload(path, f.buffer, mime);
    const { data, error } = await supabase.from('psc_imports').insert({ company_id: req.companyId, file_name: f.originalname.slice(0, 200), storage_path: path, mime_type: mime, size_bytes: f.size, created_by: req.user.id }).select('*').single();
    if (error) throw error;
    created.push(data);
    importPsc.enqueue(data);
  }
  res.status(202).json({ imports: created.map(c => ({ id: c.id, file_name: c.file_name, status: c.status })) });
}));

router.post('/psc/imports/:iid/riprova', ...auth, h(async (req, res) => {
  if (!isUuid(req.params.iid)) throw fail(404, 'Non trovato');
  const { data } = await supabase.from('psc_imports').update({ status: 'in_coda', error: null }).eq('id', req.params.iid).eq('company_id', req.companyId).select('*').maybeSingle();
  if (!data) throw fail(404, 'Non trovato');
  importPsc.enqueue(data);
  res.json({ ok: true });
}));

router.delete('/psc/imports/:iid', ...auth, h(async (req, res) => {
  if (!isUuid(req.params.iid)) throw fail(404, 'Non trovato');
  const del = req.query.con_libreria === '1';
  if (del) await supabase.from('psc_library').delete().eq('source_import', req.params.iid).eq('company_id', req.companyId);
  await supabase.from('psc_imports').delete().eq('id', req.params.iid).eq('company_id', req.companyId);
  res.json({ ok: true });
}));

module.exports = router;
