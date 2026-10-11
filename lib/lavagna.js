'use strict';
/**
 * lib/lavagna.js — F-331 (AUDIT.md del frontend): Lavagna cantieri.
 *
 * Il foglio che il capo tiene sul televisore dell'ufficio, dentro Palladia:
 * una riga per cantiere, con
 *   - quello che sa solo il titolare: urgenza (rosso/giallo/verde), cosa c'è
 *     da fare, una nota  → tabella lavagna_righe;
 *   - quello che Palladia sa meglio di lui: chi è al lavoro adesso (timbrature
 *     di oggi) e gli avvisi urgenti del Riepilogo (F-324).
 * Ci sono tutti i cantieri registrati più le righe "solo nella lavagna"
 * (site_id NULL): cantieri che stanno per iniziare o finiti e mai registrati.
 *
 * Stato di un cantiere registrato = sites.status (In corso = attivo, Fermo =
 * sospeso, Consegnato = ultimato/chiuso). "Da iniziare" su un cantiere
 * registrato è solo un'indicazione della lavagna (fase): il cantiere resta
 * attivo, si timbra come sempre, e smette di essere "da iniziare" appena
 * qualcuno timbra lì.
 */
const supabase = require('./supabase');
const { riepiloghi } = require('./cantiereRiepilogo');
const { getSiteLimit } = require('../services/stripe');

const STATI = ['da_iniziare', 'in_corso', 'fermo', 'consegnato'];
const URGENZE = ['rosso', 'giallo', 'verde', 'nessuna'];
const STATUS_DI = { da_iniziare: 'attivo', in_corso: 'attivo', fermo: 'sospeso', consegnato: 'ultimato' };
const BILLABLE = ['attivo', 'sospeso'];
const GIORNI_CONSEGNATO = 30; // un cantiere consegnato resta sulla lavagna un mese dall'ultima modifica, poi solo se ha ancora qualcosa scritto

const romeDay = (iso) => new Date(iso).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
const romeTime = (iso) => new Date(iso).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
const dayStartIso = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 2 * 3600e3).toISOString();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const conContenuto = (r) => !!r && (r.urgenza !== 'nessuna' || !!r.da_fare.trim() || !!r.note.trim());

function errore(code, message, status = 400) { return Object.assign(new Error(message || code), { code, status }); }

function statoDi(site, riga, haTimbrato) {
  if (site.status === 'sospeso') return 'fermo';
  if (site.status === 'ultimato' || site.status === 'chiuso') return 'consegnato';
  return riga?.fase === 'da_iniziare' && !haTimbrato ? 'da_iniziare' : 'in_corso';
}

// Avvisi di Palladia per la riga: solo le voci urgenti, in parole brevi.
// F-334: ogni avviso ha la sua chiave ("worker:<id>:idoneita|formazione",
// "site:<id>:pos"); quelli "già in corso" (prenotati, F-243) non si mostrano.
function avvisiDi(r, siteId, inCorso = new Set()) {
  if (!r) return [];
  const out = [];
  for (const x of r.daSistemare) {
    if (x.tipo === 'lavoratore' && x.urgente) {
      const cosa = x.cosa === 'idoneita' ? 'Visita medica' : 'Formazione';
      out.push({ chiave: `worker:${x.workerId}:${x.cosa}`, testo: `${cosa} ${x.stato} · ${x.nome}` });
    } else if (x.tipo === 'pos') {
      out.push({ chiave: `site:${siteId}:pos`, testo: 'Manca il POS' });
    }
  }
  return out.filter(a => !inCorso.has(a.chiave));
}

// ── "Già in corso" (F-334) ──────────────────────────────────────────────────
// Stessa tabella delle prenotazioni di Da fare (da_fare_prenotazioni): una
// visita prenotata qui è "In corso" anche in Da fare, campanella e card di
// Ladia, e viceversa. In Da fare la stessa scadenza può essere la riga del
// campo del lavoratore ("worker:<id>:<tipo>") o del documento ("doc:<id>"):
// le riportiamo tutte alla chiave della lavagna.
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CHIAVE_RE = new RegExp(`^(worker:${UUID_RE}:(idoneita|formazione)|site:${UUID_RE}:pos)$`, 'i');

/** Map chiave della lavagna → item_id di Da fare prenotati (ancora validi). */
async function prenotateLavagna(companyId, today) {
  const { data: pren, error } = await supabase.from('da_fare_prenotazioni').select('item_id')
    .eq('company_id', companyId).gte('torna_il', today);
  if (error) throw new Error(error.message);
  const out = new Map();
  const add = (k, id) => { if (!out.has(k)) out.set(k, []); out.get(k).push(id); };
  const docIds = [];
  for (const { item_id: id } of pren || []) {
    if (CHIAVE_RE.test(id)) add(id, id);
    else if (id.startsWith('doc:')) docIds.push(id.slice(4));
  }
  if (docIds.length) {
    const { categoryType } = require('./daFare');
    const { data: docs, error: dErr } = await supabase.from('documents').select('id, worker_id, category')
      .eq('company_id', companyId).in('id', docIds.slice(0, 200));
    if (dErr) throw new Error(dErr.message);
    for (const d of docs || []) {
      const t = d.worker_id && categoryType(d.category);
      if (t === 'idoneita' || t === 'formazione') add(`worker:${d.worker_id}:${t}`, `doc:${d.id}`);
    }
  }
  return out;
}

/** "Già in corso": mette da parte gli avvisi scelti per `giorni` (1-60). */
async function inCorso(companyId, userId, { siteId, chiavi, giorni }) {
  const g = Number(giorni);
  if (!Number.isInteger(g) || g < 1 || g > 60) throw errore('INVALID_GIORNI', 'giorni: da 1 a 60');
  if (!Array.isArray(chiavi) || !chiavi.length || chiavi.length > 30 || !chiavi.every(c => typeof c === 'string' && CHIAVE_RE.test(c))) throw errore('INVALID_CHIAVE');
  const { buildDaFare, romeDate, addDays } = require('./daFare');
  const { data: site } = await supabase.from('sites').select('id').eq('id', siteId).eq('company_id', companyId).maybeSingle();
  if (!site) throw errore('NOT_FOUND', null, 404);
  const workerIds = [...new Set(chiavi.filter(c => c.startsWith('worker:')).map(c => c.split(':')[1]))];
  if (workerIds.length) {
    const { data: ws } = await supabase.from('workers').select('id').eq('company_id', companyId).in('id', workerIds);
    if ((ws || []).length !== workerIds.length) throw errore('NOT_FOUND', null, 404);
  }
  if (chiavi.some(c => c.startsWith('site:') && c.split(':')[1] !== siteId)) throw errore('INVALID_CHIAVE');

  // La riga di Da fare della stessa scadenza (campo o documento); se Da fare
  // non la elenca (data mancante) la chiave della lavagna basta da sola.
  const daFare = workerIds.length ? await buildDaFare(companyId, null) : { items: [] };
  const tornaIl = addDays(romeDate(), g);
  const rows = [];
  for (const c of chiavi) {
    const [, id, tipo] = c.split(':');
    const items = c.startsWith('worker:') ? daFare.items.filter(i => i.kind === 'scadenza' && i.entityId === id && i.type === tipo).map(i => i.id) : [];
    for (const itemId of items.length ? items : [c]) rows.push({ company_id: companyId, item_id: itemId, torna_il: tornaIl, created_by: userId || null });
  }
  const { error } = await supabase.from('da_fare_prenotazioni').upsert(rows, { onConflict: 'company_id,item_id' });
  if (error) throw new Error(error.message);
  return { tornaIl, itemIds: rows.map(r => r.item_id) };
}

/** Annulla "Già in corso": gli avvisi tornano (anche in Da fare). */
async function annullaInCorso(companyId, { siteId, chiavi }) {
  if (!Array.isArray(chiavi) || !chiavi.length || chiavi.length > 30 || !chiavi.every(c => typeof c === 'string' && CHIAVE_RE.test(c))) throw errore('INVALID_CHIAVE');
  if (chiavi.some(c => c.startsWith('site:') && c.split(':')[1] !== siteId)) throw errore('INVALID_CHIAVE');
  const mappa = await prenotateLavagna(companyId, romeDay(new Date().toISOString()));
  const ids = chiavi.flatMap(c => mappa.get(c) || []);
  if (!ids.length) return { itemIds: [] };
  const { error } = await supabase.from('da_fare_prenotazioni').delete().eq('company_id', companyId).in('item_id', ids);
  if (error) throw new Error(error.message);
  return { itemIds: ids };
}

/**
 * Timbrature di oggi (in ordine di tempo) → per cantiere: quanti sono dentro
 * adesso, prima entrata, ultima uscita. "Dentro" = l'ultima timbratura di oggi
 * del lavoratore, ovunque, è un'entrata qui (F-221: chi è entrato qui ed è
 * uscito da un altro cantiere non è più qui).
 */
function presenzeOggi(logs) {
  const ultimo = new Map();
  const primaEntrata = new Map();
  const ultimaUscita = new Map();
  for (const l of logs) {
    ultimo.set(l.worker_id, l);
    if (l.event_type === 'ENTRY' && !primaEntrata.has(l.site_id)) primaEntrata.set(l.site_id, l.timestamp_server);
    if (l.event_type === 'EXIT') ultimaUscita.set(l.site_id, l.timestamp_server);
  }
  const dentro = new Map();
  for (const l of ultimo.values()) if (l.event_type === 'ENTRY') dentro.set(l.site_id, (dentro.get(l.site_id) || 0) + 1);
  return { dentro, primaEntrata, ultimaUscita };
}

/** Tutta la lavagna dell'azienda. */
async function lavagna(companyId, { today = romeDay(new Date().toISOString()) } = {}) {
  const [sitesRes, righeRes] = await Promise.all([
    supabase.from('sites').select('id, name, status').eq('company_id', companyId).neq('status', 'eliminato'),
    supabase.from('lavagna_righe').select('*').eq('company_id', companyId),
  ]);
  if (sitesRes.error) throw new Error(sitesRes.error.message);
  if (righeRes.error) throw new Error(righeRes.error.message);
  const sites = sitesRes.data || [];
  let righe = righeRes.data || [];

  // Una riga "solo nella lavagna" con lo stesso nome di un cantiere registrato
  // che non ha ancora la sua riga: è lui, registrato dopo. Si collega da sola.
  const conRiga = new Set(righe.filter(r => r.site_id).map(r => r.site_id));
  const perNome = new Map();
  for (const s of sites) if (!conRiga.has(s.id) && ['attivo', 'sospeso'].includes(s.status)) perNome.set(norm(s.name), s);
  for (const r of righe.filter(x => !x.site_id)) {
    const s = perNome.get(norm(r.nome));
    if (!s) continue;
    const { data, error } = await supabase.from('lavagna_righe').update({ site_id: s.id, updated_at: new Date().toISOString() })
      .eq('id', r.id).eq('company_id', companyId).is('site_id', null).select('*').maybeSingle();
    if (!error && data) { righe = righe.map(x => x.id === r.id ? data : x); perNome.delete(norm(r.nome)); }
  }

  const siteIds = sites.map(s => s.id);
  const [riep, logsRes, prenotate] = await Promise.all([
    siteIds.length ? riepiloghi(companyId, { today }) : new Map(),
    supabase.from('presence_logs').select('site_id, worker_id, event_type, timestamp_server')
      .eq('company_id', companyId).gte('timestamp_server', dayStartIso(today)).order('timestamp_server', { ascending: true }),
    prenotateLavagna(companyId, today),
  ]);
  const giaInCorso = new Set(prenotate.keys());
  if (logsRes.error) throw new Error(logsRes.error.message);
  const logs = (logsRes.data || []).filter(l => romeDay(l.timestamp_server) === today);

  const { dentro, primaEntrata, ultimaUscita } = presenzeOggi(logs);

  const rigaDi = new Map(righe.filter(r => r.site_id).map(r => [r.site_id, r]));
  const limite = Date.now() - GIORNI_CONSEGNATO * 86400e3;
  const out = [];
  for (const s of sites) {
    const riga = rigaDi.get(s.id) || null;
    const r = riep.get(s.id);
    const haTimbrato = !!r?.ultimoGiorno || primaEntrata.has(s.id);
    const stato = statoDi(s, riga, haTimbrato);
    if (stato === 'consegnato' && !conContenuto(riga) && !(riga && Date.parse(riga.updated_at) >= limite)) continue;
    out.push({
      id: riga?.id || null,
      siteId: s.id,
      nome: s.name,
      registrato: true,
      stato,
      urgenza: riga?.urgenza || 'nessuna',
      daFare: riga?.da_fare || '',
      note: riga?.note || '',
      operai: {
        adesso: dentro.get(s.id) || 0,
        dalle: primaEntrata.has(s.id) ? romeTime(primaEntrata.get(s.id)) : null,
        finoAlle: !dentro.get(s.id) && ultimaUscita.has(s.id) ? romeTime(ultimaUscita.get(s.id)) : null,
        ultimoGiorno: r?.ultimoGiorno?.day || null,
      },
      avvisi: stato === 'consegnato' ? [] : avvisiDi(r, s.id, giaInCorso),
    });
  }
  for (const riga of righe.filter(x => !x.site_id)) {
    out.push({
      id: riga.id, siteId: null, nome: riga.nome, registrato: false, stato: riga.fase,
      urgenza: riga.urgenza, daFare: riga.da_fare, note: riga.note, operai: null, avvisi: [],
    });
  }
  return { oggi: today, righe: out };
}

async function limiteCantieri(companyId, siteId) {
  const { data: company } = await supabase.from('companies')
    .select('subscription_plan, subscription_status, trial_ends_at').eq('id', companyId).single();
  if (!company) return;
  const trialExpired = company.subscription_status === 'trial' && company.trial_ends_at && Date.parse(company.trial_ends_at) < Date.now();
  const max = getSiteLimit(trialExpired ? 'trial' : company.subscription_plan);
  if (max == null) return;
  const { count } = await supabase.from('sites').select('id', { count: 'exact', head: true })
    .eq('company_id', companyId).in('status', BILLABLE).neq('id', siteId);
  if (count >= max) throw errore('SITE_LIMIT_REACHED', `Il tuo piano consente al massimo ${max} cantieri in corso o fermi. Segna come consegnato un cantiere finito, oppure aggiorna il piano.`, 403);
}

function testo(v, campo) {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw errore('INVALID_FIELD', campo);
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length > 300) throw errore('TOO_LONG', `${campo}: al massimo 300 caratteri`);
  return t;
}

/**
 * Salva una riga: { rigaId } per una riga solo nella lavagna, { siteId } per un
 * cantiere registrato (la riga si crea alla prima modifica).
 * Campi: urgenza, daFare, note, stato. Ritorna { riga, statusPrima, statusDopo }.
 */
async function salva(companyId, userId, { rigaId, siteId, urgenza, daFare, note, stato }) {
  if (urgenza !== undefined && !URGENZE.includes(urgenza)) throw errore('INVALID_URGENZA');
  if (stato !== undefined && !STATI.includes(stato)) throw errore('INVALID_STATO');
  const patch = { updated_at: new Date().toISOString(), updated_by: userId || null };
  if (urgenza !== undefined) patch.urgenza = urgenza;
  const df = testo(daFare, 'Da fare'); if (df !== undefined) patch.da_fare = df;
  const nt = testo(note, 'Note'); if (nt !== undefined) patch.note = nt;

  if (rigaId) {
    if (stato !== undefined) patch.fase = stato;
    const { data, error } = await supabase.from('lavagna_righe').update(patch)
      .eq('id', rigaId).eq('company_id', companyId).is('site_id', null).select('*').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw errore('NOT_FOUND', null, 404);
    return { riga: data };
  }

  const { data: site } = await supabase.from('sites').select('id, name, status')
    .eq('id', siteId).eq('company_id', companyId).neq('status', 'eliminato').maybeSingle();
  if (!site) throw errore('NOT_FOUND', null, 404);
  let statusDopo = site.status;
  if (stato !== undefined) {
    statusDopo = STATUS_DI[stato];
    // consegnato resta consegnato anche se era "chiuso"
    if (stato === 'consegnato' && site.status === 'chiuso') statusDopo = 'chiuso';
    if (statusDopo !== site.status && BILLABLE.includes(statusDopo) && !BILLABLE.includes(site.status)) await limiteCantieri(companyId, site.id);
    patch.fase = stato === 'da_iniziare' ? 'da_iniziare' : 'in_corso';
  }
  const { data: riga, error } = await supabase.from('lavagna_righe')
    .upsert({ company_id: companyId, site_id: site.id, ...patch }, { onConflict: 'company_id,site_id' })
    .select('*').single();
  if (error) throw new Error(error.message);
  if (statusDopo !== site.status) {
    const { error: e2 } = await supabase.from('sites').update({ status: statusDopo }).eq('id', site.id).eq('company_id', companyId);
    if (e2) throw new Error(e2.message);
  }
  return { riga, statusPrima: site.status, statusDopo };
}

/** Nuova riga solo nella lavagna: basta il nome. Nasce "Da iniziare". */
async function crea(companyId, userId, nome) {
  const n = testo(nome, 'Nome');
  if (!n) throw errore('NOME_RICHIESTO', 'Scrivi il nome o la via del cantiere.');
  if (n.length > 120) throw errore('TOO_LONG', 'Nome: al massimo 120 caratteri');
  const { data, error } = await supabase.from('lavagna_righe')
    .insert({ company_id: companyId, nome: n, fase: 'da_iniziare', urgenza: 'nessuna', updated_by: userId || null })
    .select('*').single();
  if (error) throw new Error(error.message);
  return data;
}

/** Toglie dalla lavagna una riga che non è un cantiere registrato. */
async function togli(companyId, rigaId) {
  const { data, error } = await supabase.from('lavagna_righe').delete()
    .eq('id', rigaId).eq('company_id', companyId).is('site_id', null).select('id');
  if (error) throw new Error(error.message);
  if (!data?.length) throw errore('NOT_FOUND', null, 404);
}

/** "È il cantiere…": la riga solo nella lavagna diventa quella del cantiere registrato. */
async function collega(companyId, userId, rigaId, siteId) {
  const [{ data: libera }, { data: site }, { data: esistente }] = await Promise.all([
    supabase.from('lavagna_righe').select('*').eq('id', rigaId).eq('company_id', companyId).is('site_id', null).maybeSingle(),
    supabase.from('sites').select('id').eq('id', siteId).eq('company_id', companyId).neq('status', 'eliminato').maybeSingle(),
    supabase.from('lavagna_righe').select('*').eq('company_id', companyId).eq('site_id', siteId).maybeSingle(),
  ]);
  if (!libera || !site) throw errore('NOT_FOUND', null, 404);
  const unisci = (a, b) => [a, b].map(x => (x || '').trim()).filter(Boolean).filter((x, i, arr) => arr.indexOf(x) === i).join(' · ').slice(0, 300);
  const urg = [esistente?.urgenza, libera.urgenza].filter(Boolean).sort((a, b) => URGENZE.indexOf(a) - URGENZE.indexOf(b))[0] || 'nessuna';
  const riga = {
    company_id: companyId, site_id: siteId, urgenza: urg,
    da_fare: unisci(esistente?.da_fare, libera.da_fare), note: unisci(esistente?.note, libera.note),
    fase: libera.fase === 'da_iniziare' ? 'da_iniziare' : (esistente?.fase || 'in_corso'),
    updated_at: new Date().toISOString(), updated_by: userId || null,
  };
  const { data, error } = await supabase.from('lavagna_righe').upsert(riga, { onConflict: 'company_id,site_id' }).select('*').single();
  if (error) throw new Error(error.message);
  await supabase.from('lavagna_righe').delete().eq('id', libera.id).eq('company_id', companyId);
  return data;
}

module.exports = { presenzeOggi, lavagna, salva, crea, togli, collega, inCorso, annullaInCorso, STATI, URGENZE };
