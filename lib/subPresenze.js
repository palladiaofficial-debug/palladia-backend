'use strict';
/**
 * lib/subPresenze.js — F-337 (AUDIT.md del frontend): presenze in cantiere
 * degli operai delle imprese subappaltatrici.
 *
 * Tabelle proprie (migrazione 249): sub_workers, sub_presenze, sub_squad_links,
 * sub_impresa_ignota. Qui si LEGGE soltanto da workers/presence_logs (per non
 * creare doppioni e per contare "i nostri"); non si scrive mai lì. Le persone
 * dei subappaltatori non compaiono quindi in ore, foglio ore, buste paga,
 * Organico, "chi non ha timbrato", push.
 *
 * Tre modi di segnare la stessa presenza: QR all'ingresso (telefono
 * dell'operaio), link della squadra (caposquadra del sub, senza account),
 * appello dall'ufficio (preposto). Tutti passano da segna().
 */
const crypto = require('crypto');
const supabase = require('./supabase');
const { complianceStatus } = require('./compliance');
const { isFeatureEnabled } = require('./featureFlags');
const { risolviOrario } = require('./oreContrattuali');
const { codiceFiscaleValido, normalizza } = require('./codiceFiscale');

const FLAG = 'presenze_imprese';
const INFORMATIVA_VERSION = '2026-10-11';
const MINUTI_DOPO_FINE = 60;      // dopo la fine dell'orario + 1 h chi non ha segnato l'uscita non è più "dentro"
const TOLLERANZA_LONTANO_M = 300; // oltre il raggio del cantiere + 300 m = "lontano dal cantiere"
const STATI_CHIUSI = ['chiuso', 'eliminato', 'ultimato'];

const romeDay = (iso) => new Date(iso).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
const romeTime = (iso) => new Date(iso).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
const romeMinutes = (iso) => { const [h, m] = romeTime(iso).split(':').map(Number); return h * 60 + m; };
// Margine largo: si filtra poi per giorno di Roma.
const dayStartIso = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 3 * 3600e3).toISOString();
const normNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
const nomePulito = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);

function errore(code, message, status = 400) { return Object.assign(new Error(message || code), { code, status }); }
function dbErr(error) { if (error) throw errore('DB_ERROR', error.message, 500); }

function segreto() {
  const s = process.env.QR_SIGNING_SECRET;
  if (!s) throw errore('SIGNING_NOT_CONFIGURED', 'QR_SIGNING_SECRET mancante', 500);
  return s;
}
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// ── Gettone del telefono dell'operaio (firmato, come il QR) ──────────────────
function gettonePersona(subWorkerId) {
  const sig = crypto.createHmac('sha256', segreto()).update(`sub-worker.${subWorkerId}`).digest('hex');
  return `sw1.${subWorkerId}.${sig}`;
}
function idDaGettone(token) {
  const m = /^sw1\.([0-9a-f-]{36})\.([0-9a-f]{64})$/i.exec(String(token || ''));
  if (!m) return null;
  const atteso = crypto.createHmac('sha256', segreto()).update(`sub-worker.${m[1]}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(atteso, 'hex')) ? m[1] : null;
}

async function personaDaGettone(token) {
  const id = idDaGettone(token);
  if (!id) throw errore('DEVICE_TOKEN_INVALID', 'Telefono non riconosciuto', 401);
  const { data, error } = await supabase.from('sub_workers')
    .select('id, company_id, subcontractor_id, full_name, deactivated_at').eq('id', id).maybeSingle();
  dbErr(error);
  if (!data || data.deactivated_at) throw errore('DEVICE_TOKEN_INVALID', 'Telefono non riconosciuto', 401);
  return data;
}

// ── Cantiere e imprese ──────────────────────────────────────────────────────
async function cantiere(siteId) {
  const { data, error } = await supabase.from('sites')
    .select('id, name, address, company_id, status, latitude, longitude, geofence_radius_m, orario_inizio, orario_fine, pausa_inizio, pausa_fine')
    .eq('id', siteId).maybeSingle();
  dbErr(error);
  if (!data) throw errore('WORKSITE_NOT_FOUND', 'Cantiere non trovato', 404);
  return data;
}

async function attivoPer(companyId) {
  try { return await isFeatureEnabled(companyId, FLAG); } catch { return false; }
}

/** Subappaltatori assegnati a un cantiere e attivi. */
async function subDelCantiere(companyId, siteId) {
  const { data, error } = await supabase.from('site_subcontractors')
    .select('subcontractor_id, subcontractors:subcontractor_id(id, company_name, is_active, durc_expiry, insurance_expiry)')
    .eq('site_id', siteId).eq('company_id', companyId);
  dbErr(error);
  return (data || []).map(r => r.subcontractors).filter(s => s && s.is_active !== false);
}

/**
 * Le imprese tra cui sceglie chi inquadra il QR: la nostra (id 'own') più i
 * subappaltatori del cantiere, solo se il modulo è attivo per l'azienda.
 * Usata anche da /scan/identify (F-336).
 */
async function impreseDelCantiere(siteId) {
  const site = await cantiere(siteId);
  const [{ data: company }, attivo] = await Promise.all([
    supabase.from('companies').select('id, name').eq('id', site.company_id).maybeSingle(),
    attivoPer(site.company_id),
  ]);
  const imprese = [{ id: 'own', nome: company?.name || 'La nostra impresa', nostra: true }];
  if (attivo) {
    for (const s of await subDelCantiere(site.company_id, site.id)) imprese.push({ id: s.id, nome: s.company_name, nostra: false });
  }
  return { site, company, attivo, imprese };
}

async function subAssegnato(companyId, siteId, subId) {
  return (await subDelCantiere(companyId, siteId)).find(s => s.id === subId) || null;
}

// ── Stato di oggi ───────────────────────────────────────────────────────────
function fineGiornataMin(company, site) {
  return risolviOrario({ company: company || {}, site }).fine + MINUTI_DOPO_FINE;
}

/** Presenze valide di oggi (ora di Roma) di un'azienda, in ordine di tempo. */
async function presenzeDiOggi(companyId, today, { subWorkerIds } = {}) {
  let q = supabase.from('sub_presenze')
    .select('id, site_id, subcontractor_id, sub_worker_id, event, at, source, distance_m')
    .eq('company_id', companyId).is('annullata_at', null).gte('at', dayStartIso(today))
    .order('at', { ascending: true }).order('created_at', { ascending: true });
  if (subWorkerIds) q = q.in('sub_worker_id', subWorkerIds);
  const { data, error } = await q;
  dbErr(error);
  return (data || []).filter(p => romeDay(p.at) === today);
}

/**
 * Per persona: dove è dentro adesso (ultima presenza di oggi, ovunque,
 * un'entrata), entrata e uscita per cantiere, uscita non segnata.
 */
function statoPersone(presenze, { nowIso, fineMin }) {
  const per = new Map();
  for (const p of presenze) {
    const s = per.get(p.sub_worker_id) || { ultimo: null, perSito: new Map() };
    s.ultimo = p;
    const ps = s.perSito.get(p.site_id) || { entrata: null, uscita: null, source: null, distanceM: null };
    if (p.event === 'entrata') { if (!ps.entrata) ps.entrata = p.at; ps.uscita = null; ps.source = p.source; ps.distanceM = p.distance_m; }
    else ps.uscita = p.at;
    s.perSito.set(p.site_id, ps);
    per.set(p.sub_worker_id, s);
  }
  const adesso = romeMinutes(nowIso);
  for (const s of per.values()) {
    const aperto = s.ultimo?.event === 'entrata';
    // Chi è entrato dopo la fine della giornata (turno di sera) resta dentro fino a mezzanotte
    const oltre = adesso > fineMin && aperto && romeMinutes(s.ultimo.at) <= fineMin;
    s.dentroSito = aperto && !oltre ? s.ultimo.site_id : null;
    s.uscitaNonSegnata = aperto && oltre ? s.ultimo.site_id : null;
  }
  return per;
}

async function contestoAzienda(companyId) {
  const { data, error } = await supabase.from('companies')
    .select('id, name, orario_inizio, orario_fine, pausa_inizio, pausa_fine').eq('id', companyId).maybeSingle();
  dbErr(error);
  return data || { id: companyId };
}

async function statoDi(subWorker, { nowIso = new Date().toISOString() } = {}) {
  const today = romeDay(nowIso);
  const company = await contestoAzienda(subWorker.company_id);
  const presenze = await presenzeDiOggi(subWorker.company_id, today, { subWorkerIds: [subWorker.id] });
  const st = statoPersone(presenze, { nowIso, fineMin: fineGiornataMin(company, null) }).get(subWorker.id);
  return { dentroSito: st?.dentroSito || null, ultimo: st?.ultimo || null };
}

// ── Scrittura di un'entrata o un'uscita ─────────────────────────────────────
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000, r = (d) => d * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function gpsRiga(site, gps) {
  const lat = Number(gps?.latitude), lon = Number(gps?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return {};
  const acc = Number(gps?.accuracy);
  const out = { latitude: lat, longitude: lon, gps_accuracy_m: Number.isFinite(acc) && acc > 0 ? Math.round(acc) : null };
  if (site.latitude != null && site.longitude != null) out.distance_m = Math.round(haversineM(lat, lon, Number(site.latitude), Number(site.longitude)));
  return out;
}

async function inserisci(row) {
  const { data, error } = await supabase.from('sub_presenze').insert(row).select('id, event, at, site_id').single();
  if (error?.code === '23505') return { doppione: true };
  dbErr(error);
  return data;
}

/**
 * Segna entrata o uscita. `event` facoltativo = cambia stato.
 * Chi entra qui mentre risulta dentro un altro cantiere esce da lì (stesso
 * minuto). Doppio tocco (stesso client_request_id, o già nello stato chiesto)
 * = nessun doppione, `unchanged: true`.
 */
async function segna({ subWorker, site, event = null, source, recordedBy = null, squadLinkId = null, gps = null, clientRequestId = null, nowIso = new Date().toISOString() }) {
  if (event && !['entrata', 'uscita'].includes(event)) throw errore('INVALID_EVENT');
  if (STATI_CHIUSI.includes(site.status)) throw errore('WORKSITE_CLOSED', 'Cantiere chiuso', 409);
  if (site.company_id !== subWorker.company_id) throw errore('NOT_FOUND', 'Persona non trovata', 404);
  if (!(await subAssegnato(site.company_id, site.id, subWorker.subcontractor_id))) {
    throw errore('IMPRESA_NON_ASSEGNATA', 'La tua impresa non è assegnata a questo cantiere. Chiedi al capocantiere.', 409);
  }
  const stato = await statoDi(subWorker, { nowIso });
  const dentroQui = stato.dentroSito === site.id;
  const evento = event || (dentroQui ? 'uscita' : 'entrata');
  if ((evento === 'entrata' && dentroQui) || (evento === 'uscita' && !dentroQui)) {
    return { unchanged: true, event: evento, dentro: dentroQui };
  }
  const base = {
    company_id: site.company_id, sub_worker_id: subWorker.id, source,
    recorded_by_user: recordedBy, squad_link_id: squadLinkId, at: nowIso,
  };
  if (evento === 'entrata' && stato.dentroSito) {
    await inserisci({ ...base, site_id: stato.dentroSito, subcontractor_id: subWorker.subcontractor_id, event: 'uscita' });
  }
  const r = await inserisci({
    ...base, site_id: site.id, subcontractor_id: subWorker.subcontractor_id, event: evento,
    client_request_id: clientRequestId ? String(clientRequestId).slice(0, 80) : null,
    ...gpsRiga(site, gps),
  });
  if (r.doppione) return { unchanged: true, event: evento, dentro: evento === 'entrata' };
  return { unchanged: false, event: evento, dentro: evento === 'entrata', at: r.at, id: r.id };
}

// ── Persone ─────────────────────────────────────────────────────────────────
async function dipendenteConCf(companyId, cf) {
  const { data, error } = await supabase.from('workers').select('id, is_active')
    .eq('company_id', companyId).eq('fiscal_code', cf).maybeSingle();
  dbErr(error);
  return data && data.is_active !== false ? data : null;
}

/**
 * Prima volta dal QR: crea o ritrova la persona (per codice fiscale, poi per
 * nome tra quelle aggiunte dal caposquadra senza codice), registra
 * l'informativa, restituisce il gettone del telefono.
 */
async function registraDaQr({ siteId, impresaId, fullName, fiscalCode, nowIso = new Date().toISOString() }) {
  const site = await cantiere(siteId);
  if (!(await attivoPer(site.company_id))) throw errore('MODULO_NON_ATTIVO', 'Chiedi al capocantiere di segnarti', 403);
  // F-361: senza tessera (illeggibile o dimenticata) si entra con nome e cognome scritti a mano,
  // come quando il caposquadra aggiunge una persona: prima l'operaio restava bloccato.
  const senzaTessera = fiscalCode == null || fiscalCode === '';
  const cf = senzaTessera ? null : normalizza(fiscalCode);
  if (!senzaTessera && !codiceFiscaleValido(cf)) throw errore('INVALID_FISCAL_CODE', 'Codice fiscale non valido');
  const nome = nomePulito(fullName);
  if (nome.length < 3 || (senzaTessera && !/\s/.test(nome))) throw errore('FULL_NAME_REQUIRED', 'Scrivi nome e cognome');
  const sub = await subAssegnato(site.company_id, site.id, impresaId);
  if (!sub) throw errore('IMPRESA_NON_ASSEGNATA', 'Questa impresa non è assegnata al cantiere', 409);
  if (cf && await dipendenteConCf(site.company_id, cf)) throw errore('GIA_DIPENDENTE', 'Sei già un nostro lavoratore: usa il tuo badge personale', 409);

  const campi = { subcontractor_id: sub.id, full_name: nome, informativa_version: INFORMATIVA_VERSION, informativa_at: nowIso, deactivated_at: null, updated_at: nowIso };
  if (cf) campi.fiscal_code = cf; // senza tessera non si cancella un codice fiscale già noto
  let persona = null;
  if (cf) {
    const { data, error } = await supabase.from('sub_workers').select('id')
      .eq('company_id', site.company_id).eq('fiscal_code', cf).maybeSingle();
    dbErr(error);
    persona = data;
  }
  if (!persona && senzaTessera) {
    // la stessa persona già registrata con la tessera (stesso nome, stessa impresa)
    const { data: tutte, error: e1 } = await supabase.from('sub_workers').select('id, full_name')
      .eq('company_id', site.company_id).eq('subcontractor_id', sub.id).is('deactivated_at', null);
    dbErr(e1);
    const k = normNome(nome).split(' ').sort().join(' ');
    persona = (tutte || []).find(p => normNome(p.full_name).split(' ').sort().join(' ') === k) || null;
  }
  if (!persona) {
    const { data: senzaCf, error: e2 } = await supabase.from('sub_workers').select('id, full_name')
      .eq('company_id', site.company_id).eq('subcontractor_id', sub.id).is('fiscal_code', null);
    dbErr(e2);
    persona = (senzaCf || []).find(p => normNome(p.full_name) === normNome(nome)
      || normNome(p.full_name).split(' ').sort().join(' ') === normNome(nome).split(' ').sort().join(' ')) || null;
  }
  if (persona) {
    // senza tessera resta il nome già registrato (quello letto dalla tessera è più affidabile)
    const { error: e3 } = await supabase.from('sub_workers').update(senzaTessera ? { ...campi, full_name: undefined } : campi).eq('id', persona.id);
    dbErr(e3);
  } else {
    const { data, error: e4 } = await supabase.from('sub_workers')
      .insert({ company_id: site.company_id, added_via: 'qr', ...campi }).select('id').single();
    if (e4?.code === '23505') return registraDaQr({ siteId, impresaId, fullName, fiscalCode, nowIso });
    dbErr(e4);
    persona = data;
  }
  return { subWorkerId: persona.id, fullName: nome, impresa: sub.company_name, deviceToken: gettonePersona(persona.id) };
}

/** "La mia impresa non c'è": entra, e al titolare arriva un avviso rosso. */
async function registraImpresaIgnota({ siteId, impresaNome, fullName, fiscalCode, nowIso = new Date().toISOString() }) {
  const site = await cantiere(siteId);
  if (!(await attivoPer(site.company_id))) throw errore('MODULO_NON_ATTIVO', 'Chiedi al capocantiere di segnarti', 403);
  // F-361: anche qui si può entrare senza tessera, con nome e cognome
  const senzaTessera = fiscalCode == null || fiscalCode === '';
  const cf = senzaTessera ? null : normalizza(fiscalCode);
  if (!senzaTessera && !codiceFiscaleValido(cf)) throw errore('INVALID_FISCAL_CODE', 'Codice fiscale non valido');
  const nome = nomePulito(fullName);
  if (senzaTessera && (nome.length < 3 || !/\s/.test(nome))) throw errore('FULL_NAME_REQUIRED', 'Scrivi nome e cognome');
  const impresa = nomePulito(impresaNome);
  if (impresa.length < 2) throw errore('IMPRESA_REQUIRED', 'Scrivi il nome della tua impresa');
  if (cf && await dipendenteConCf(site.company_id, cf)) throw errore('GIA_DIPENDENTE', 'Sei già un nostro lavoratore: usa il tuo badge personale', 409);
  const today = romeDay(nowIso);
  let q = supabase.from('sub_impresa_ignota').select('id, at, full_name').eq('site_id', site.id).gte('at', dayStartIso(today));
  q = cf ? q.eq('fiscal_code', cf) : q.is('fiscal_code', null);
  const { data: gia, error } = await q;
  dbErr(error);
  if ((gia || []).some(g => romeDay(g.at) === today && (cf || normNome(g.full_name) === normNome(nome)))) return { unchanged: true };
  const { error: e2 } = await supabase.from('sub_impresa_ignota').insert({
    company_id: site.company_id, site_id: site.id, full_name: nome || cf, fiscal_code: cf, impresa_nome: impresa, at: nowIso,
  });
  dbErr(e2);
  return { unchanged: false };
}

async function aggiungiPersona({ companyId, subcontractorId, fullName, addedVia }) {
  const nome = nomePulito(fullName);
  if (nome.length < 3 || !/\s/.test(nome)) throw errore('FULL_NAME_REQUIRED', 'Scrivi nome e cognome');
  const { data: gia, error } = await supabase.from('sub_workers').select('id, full_name, deactivated_at')
    .eq('company_id', companyId).eq('subcontractor_id', subcontractorId);
  dbErr(error);
  const stesso = (gia || []).find(p => normNome(p.full_name) === normNome(nome));
  if (stesso) {
    if (stesso.deactivated_at) {
      const { error: e } = await supabase.from('sub_workers').update({ deactivated_at: null, updated_at: new Date().toISOString() }).eq('id', stesso.id);
      dbErr(e);
    }
    return { id: stesso.id, fullName: stesso.full_name, unchanged: true };
  }
  const { data, error: e2 } = await supabase.from('sub_workers')
    .insert({ company_id: companyId, subcontractor_id: subcontractorId, full_name: nome, added_via: addedVia }).select('id, full_name').single();
  dbErr(e2);
  return { id: data.id, fullName: data.full_name, unchanged: false };
}

// ── Link della squadra ──────────────────────────────────────────────────────
async function creaLinkSquadra({ companyId, siteId, subcontractorId, userId }) {
  const site = await cantiere(siteId);
  if (site.company_id !== companyId) throw errore('NOT_FOUND', 'Cantiere non trovato', 404);
  if (!(await subAssegnato(companyId, siteId, subcontractorId))) throw errore('IMPRESA_NON_ASSEGNATA', 'Assegna prima l\'impresa al cantiere', 409);
  const now = new Date().toISOString();
  const { error } = await supabase.from('sub_squad_links').update({ revoked_at: now })
    .eq('site_id', siteId).eq('subcontractor_id', subcontractorId).is('revoked_at', null);
  dbErr(error);
  const token = crypto.randomBytes(24).toString('base64url');
  const { error: e2 } = await supabase.from('sub_squad_links').insert({
    company_id: companyId, site_id: siteId, subcontractor_id: subcontractorId, token_hash: hashToken(token), created_by: userId || null,
  });
  dbErr(e2);
  return { token };
}

async function revocaLinkSquadra({ companyId, siteId, subcontractorId }) {
  const { error } = await supabase.from('sub_squad_links').update({ revoked_at: new Date().toISOString() })
    .eq('company_id', companyId).eq('site_id', siteId).eq('subcontractor_id', subcontractorId).is('revoked_at', null);
  dbErr(error);
}

async function linkDaToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) throw errore('LINK_NON_VALIDO', 'Link non valido', 401);
  const { data, error } = await supabase.from('sub_squad_links')
    .select('id, company_id, site_id, subcontractor_id, revoked_at').eq('token_hash', hashToken(token)).maybeSingle();
  dbErr(error);
  if (!data || data.revoked_at) throw errore('LINK_NON_VALIDO', 'Questo link non vale più. Chiedi un link nuovo all\'impresa.', 401);
  if (!(await attivoPer(data.company_id))) throw errore('LINK_NON_VALIDO', 'Questo link non vale più.', 401);
  const site = await cantiere(data.site_id);
  const sub = await subAssegnato(data.company_id, data.site_id, data.subcontractor_id);
  if (!sub) throw errore('LINK_NON_VALIDO', 'L\'impresa non è più assegnata a questo cantiere.', 401);
  supabase.from('sub_squad_links').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).then(() => {}, () => {});
  return { link: data, site, sub };
}

async function personeDelSub(companyId, subcontractorId) {
  const { data, error } = await supabase.from('sub_workers').select('id, full_name, fiscal_code, company_id, subcontractor_id')
    .eq('company_id', companyId).eq('subcontractor_id', subcontractorId).is('deactivated_at', null).order('full_name');
  dbErr(error);
  return data || [];
}

/** Pagina del caposquadra: la sua squadra e chi è dentro oggi in questo cantiere. */
async function squadra(token, { nowIso = new Date().toISOString() } = {}) {
  const { site, sub } = await linkDaToken(token);
  const company = await contestoAzienda(site.company_id);
  const persone = await personeDelSub(site.company_id, sub.id);
  const today = romeDay(nowIso);
  const presenze = persone.length ? await presenzeDiOggi(site.company_id, today, { subWorkerIds: persone.map(p => p.id) }) : [];
  const st = statoPersone(presenze, { nowIso, fineMin: fineGiornataMin(company, site) });
  return {
    cantiere: { nome: site.name, indirizzo: site.address || '' },
    impresa: sub.company_name,
    azienda: company.name || '',
    persone: persone.map(p => {
      const s = st.get(p.id);
      const qui = s?.perSito.get(site.id);
      return {
        id: p.id, nome: p.full_name,
        dentro: s?.dentroSito === site.id,
        altroCantiere: !!s?.dentroSito && s.dentroSito !== site.id,
        entrata: qui?.entrata ? romeTime(qui.entrata) : null,
        uscita: qui?.uscita ? romeTime(qui.uscita) : null,
      };
    }),
  };
}

async function segnaDaSquadra(token, { subWorkerId, event, clientRequestId }) {
  const { link, site, sub } = await linkDaToken(token);
  const persona = (await personeDelSub(site.company_id, sub.id)).find(p => p.id === subWorkerId);
  if (!persona) throw errore('NOT_FOUND', 'Persona non trovata', 404);
  return segna({ subWorker: persona, site, event, source: 'squadra', squadLinkId: link.id, clientRequestId });
}

async function aggiungiDaSquadra(token, { fullName }) {
  const { site, sub } = await linkDaToken(token);
  return aggiungiPersona({ companyId: site.company_id, subcontractorId: sub.id, fullName, addedVia: 'squadra' });
}

async function tuttiFuori(token) {
  const { link, site, sub } = await linkDaToken(token);
  const out = [];
  for (const p of await personeDelSub(site.company_id, sub.id)) {
    const r = await segna({ subWorker: p, site, event: 'uscita', source: 'squadra', squadLinkId: link.id });
    if (!r.unchanged) out.push(p.id);
  }
  return { usciti: out.length };
}

// ── Ufficio ─────────────────────────────────────────────────────────────────
async function cantiereDellAzienda(companyId, siteId) {
  const site = await cantiere(siteId);
  if (site.company_id !== companyId) throw errore('NOT_FOUND', 'Cantiere non trovato', 404);
  return site;
}

async function segnaDaUfficio({ companyId, userId, siteId, subWorkerId, event }) {
  const site = await cantiereDellAzienda(companyId, siteId);
  const { data: persona, error } = await supabase.from('sub_workers').select('id, company_id, subcontractor_id, full_name, deactivated_at')
    .eq('id', subWorkerId).eq('company_id', companyId).maybeSingle();
  dbErr(error);
  if (!persona || persona.deactivated_at) throw errore('NOT_FOUND', 'Persona non trovata', 404);
  return segna({ subWorker: persona, site, event, source: 'ufficio', recordedBy: userId });
}

async function annulla({ companyId, userId, presenzaId }) {
  const { data, error } = await supabase.from('sub_presenze').update({ annullata_at: new Date().toISOString(), annullata_da: userId })
    .eq('id', presenzaId).eq('company_id', companyId).is('annullata_at', null).select('id').maybeSingle();
  dbErr(error);
  if (!data) throw errore('NOT_FOUND', 'Presenza non trovata', 404);
  return { ok: true };
}

async function chiudiIgnota({ companyId, userId, id, come, subcontractorId = null }) {
  if (!['assegnata', 'non_nostra'].includes(come)) throw errore('INVALID_FIELD', 'come');
  const { data: riga, error } = await supabase.from('sub_impresa_ignota').select('id, site_id, chiusa_at')
    .eq('id', id).eq('company_id', companyId).maybeSingle();
  dbErr(error);
  if (!riga) throw errore('NOT_FOUND', 'Avviso non trovato', 404);
  if (come === 'assegnata') {
    if (!subcontractorId) throw errore('SUBCONTRACTOR_ID_REQUIRED');
    const { assignSubcontractorToSite } = require('./siteSubcontractors');
    await assignSubcontractorToSite(companyId, riga.site_id, subcontractorId, null);
  }
  const { error: e2 } = await supabase.from('sub_impresa_ignota')
    .update({ chiusa_at: new Date().toISOString(), chiusa_come: come, chiusa_da: userId }).eq('id', id);
  dbErr(e2);
  return { ok: true };
}

// ── Riquadro del titolare ───────────────────────────────────────────────────
function documentiImpresa(sub) {
  const voci = [['DURC', sub.durc_expiry], ['Assicurazione', sub.insurance_expiry]];
  const scaduti = [], inScadenza = [], mancanti = [];
  for (const [nome, data] of voci) {
    const s = complianceStatus(data);
    if (s === 'expired') scaduti.push({ nome, data });
    else if (s === 'expiring') inScadenza.push({ nome, data });
    else if (s === 'not_set') mancanti.push({ nome });
  }
  const stato = scaduti.length ? 'scaduti' : inScadenza.length ? 'in_scadenza' : mancanti.length ? 'mancanti' : 'ok';
  return { stato, scaduti, inScadenza, mancanti };
}
const dataIt = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }) : '');
const elenco = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`);

/** "I nostri" dentro adesso: stessa regola della lavagna (F-221). */
async function nostriAdesso(companyId, siteId, today) {
  const { data, error } = await supabase.from('presence_logs').select('site_id, worker_id, event_type, timestamp_server')
    .eq('company_id', companyId).gte('timestamp_server', dayStartIso(today)).order('timestamp_server', { ascending: true });
  dbErr(error);
  const ultimo = new Map();
  for (const l of data || []) if (romeDay(l.timestamp_server) === today) ultimo.set(l.worker_id, l);
  let n = 0;
  for (const l of ultimo.values()) if (l.event_type === 'ENTRY' && l.site_id === siteId) n++;
  return n;
}

/**
 * Tutto quello che serve al titolare su un cantiere, oggi.
 * Avvisi: rosso = urgente (documenti scaduti con persone presenti, impresa
 * non assegnata); giallo = da sapere (in scadenza, prima volta, lontano).
 */
async function impreseOggi(companyId, siteId, { nowIso = new Date().toISOString() } = {}) {
  const site = await cantiereDellAzienda(companyId, siteId);
  const today = romeDay(nowIso);
  const company = await contestoAzienda(companyId);
  const [assegnati, presenze, nostri, ignoteRes, linksRes] = await Promise.all([
    subDelCantiere(companyId, siteId),
    presenzeDiOggi(companyId, today),
    nostriAdesso(companyId, siteId, today),
    supabase.from('sub_impresa_ignota').select('id, full_name, impresa_nome, at').eq('site_id', siteId).eq('company_id', companyId)
      .is('chiusa_at', null).gte('at', dayStartIso(today)).order('at'),
    supabase.from('sub_squad_links').select('subcontractor_id, created_at, last_used_at').eq('site_id', siteId).is('revoked_at', null),
  ]);
  dbErr(ignoteRes.error); dbErr(linksRes.error);
  const st = statoPersone(presenze, { nowIso, fineMin: fineGiornataMin(company, site) });
  const quiOggi = presenze.filter(p => p.site_id === siteId);
  const subIds = [...new Set([...assegnati.map(s => s.id), ...quiOggi.map(p => p.subcontractor_id)])];
  const personeIds = [...new Set(quiOggi.map(p => p.sub_worker_id))];

  const [subsRes, personeRes, precedentiRes] = await Promise.all([
    subIds.length ? supabase.from('subcontractors').select('id, company_name, durc_expiry, insurance_expiry, is_active, phone, contact_person').in('id', subIds).eq('company_id', companyId) : { data: [] },
    personeIds.length ? supabase.from('sub_workers').select('id, full_name, subcontractor_id').in('id', personeIds) : { data: [] },
    personeIds.length ? supabase.from('sub_presenze').select('sub_worker_id').eq('site_id', siteId).is('annullata_at', null)
      .lt('at', dayStartIso(today)).in('sub_worker_id', personeIds) : { data: [] },
  ]);
  dbErr(subsRes.error); dbErr(personeRes.error); dbErr(precedentiRes.error);
  const venutiPrima = new Set((precedentiRes.data || []).map(r => r.sub_worker_id));
  const nomeDi = new Map((personeRes.data || []).map(p => [p.id, p]));
  const linkDi = new Map((linksRes.data || []).map(l => [l.subcontractor_id, l]));
  const raggio = Number(site.geofence_radius_m) || 200;
  const assegnatiIds = new Set(assegnati.map(s => s.id));

  const imprese = (subsRes.data || []).map(sub => {
    const persone = personeIds.filter(id => nomeDi.get(id)?.subcontractor_id === sub.id || quiOggi.some(p => p.sub_worker_id === id && p.subcontractor_id === sub.id))
      .map(id => {
        const s = st.get(id);
        const qui = s?.perSito.get(siteId) || {};
        return {
          id, nome: nomeDi.get(id)?.full_name || '',
          dentro: s?.dentroSito === siteId,
          entrata: qui.entrata ? romeTime(qui.entrata) : null,
          uscita: qui.uscita ? romeTime(qui.uscita) : null,
          uscitaNonSegnata: s?.uscitaNonSegnata === siteId,
          primaVolta: !venutiPrima.has(id),
          lontano: qui.distanceM != null && qui.distanceM > raggio + TOLLERANZA_LONTANO_M,
          segnatoDa: qui.source || null,
        };
      })
      .sort((a, b) => Number(b.dentro) - Number(a.dentro) || a.nome.localeCompare(b.nome, 'it'));
    const link = linkDi.get(sub.id);
    return {
      id: sub.id, nome: sub.company_name, telefono: sub.phone || '', referente: sub.contact_person || '',
      assegnata: assegnatiIds.has(sub.id),
      documenti: documentiImpresa(sub),
      adesso: persone.filter(p => p.dentro).length,
      oggi: persone.length,
      persone,
      linkSquadra: link ? { attivo: true, creatoIl: link.created_at, usatoIl: link.last_used_at } : { attivo: false },
    };
  }).sort((a, b) => b.adesso - a.adesso || a.nome.localeCompare(b.nome, 'it'));

  const ignote = (ignoteRes.data || []).filter(r => romeDay(r.at) === today)
    .map(r => ({ id: r.id, nome: r.full_name, impresa: r.impresa_nome, ora: romeTime(r.at) }));

  const avvisi = [];
  for (const imp of imprese) {
    if (!imp.oggi) continue;
    const d = imp.documenti;
    const chi = imp.oggi === 1 ? `1 persona di ${imp.nome} è` : `${imp.oggi} persone di ${imp.nome} sono`;
    if (d.scaduti.length) {
      avvisi.push({ livello: 'rosso', tipo: 'documenti_scaduti', subcontractorId: imp.id,
        testo: `${chi} in cantiere oggi, ma ${elenco(d.scaduti.map(x => `${x.nome === 'DURC' ? 'il DURC' : 'l\'assicurazione'} è scadut${x.nome === 'DURC' ? 'o' : 'a'} il ${dataIt(x.data)}`))}.` });
    } else if (d.inScadenza.length) {
      avvisi.push({ livello: 'giallo', tipo: 'documenti_in_scadenza', subcontractorId: imp.id,
        testo: `${imp.nome}: ${elenco(d.inScadenza.map(x => `${x.nome} in scadenza il ${dataIt(x.data)}`))}.` });
    } else if (d.mancanti.length) {
      avvisi.push({ livello: 'giallo', tipo: 'documenti_mancanti', subcontractorId: imp.id,
        testo: `${imp.nome}: ${elenco(d.mancanti.map(x => x.nome))} senza scadenza registrata.` });
    }
    const nuovi = imp.persone.filter(p => p.primaVolta).map(p => p.nome);
    if (nuovi.length) avvisi.push({ livello: 'giallo', tipo: 'prima_volta', subcontractorId: imp.id, testo: `Prima volta qui: ${elenco(nuovi)} (${imp.nome}).` });
    const lontani = imp.persone.filter(p => p.lontano).map(p => p.nome);
    if (lontani.length) avvisi.push({ livello: 'giallo', tipo: 'lontano', subcontractorId: imp.id, testo: `Entrata segnata lontano dal cantiere: ${elenco(lontani)} (${imp.nome}).` });
  }
  for (const ig of ignote) {
    avvisi.push({ livello: 'rosso', tipo: 'impresa_non_assegnata', ignotaId: ig.id,
      testo: `${ig.nome} è entrato alle ${ig.ora} dicendo di lavorare per "${ig.impresa}", che non è assegnata a questo cantiere.` });
  }
  avvisi.sort((a, b) => (a.livello === b.livello ? 0 : a.livello === 'rosso' ? -1 : 1));

  const altreAdesso = imprese.reduce((s, i) => s + i.adesso, 0);
  return { oggi: today, cantiere: { id: site.id, nome: site.name }, nostri, altreAdesso, totaleAdesso: nostri + altreAdesso, imprese, ignote, avvisi };
}

/** Per la lavagna: persone di altre imprese dentro adesso, per cantiere. */
async function altreImpreseAdesso(companyId, { nowIso = new Date().toISOString() } = {}) {
  if (!(await attivoPer(companyId))) return new Map();
  const today = romeDay(nowIso);
  const company = await contestoAzienda(companyId);
  const st = statoPersone(await presenzeDiOggi(companyId, today), { nowIso, fineMin: fineGiornataMin(company, null) });
  const out = new Map();
  for (const s of st.values()) if (s.dentroSito) out.set(s.dentroSito, (out.get(s.dentroSito) || 0) + 1);
  return out;
}

module.exports = {
  FLAG, INFORMATIVA_VERSION, errore,
  impreseDelCantiere, attivoPer, cantiere, gettonePersona, idDaGettone, personaDaGettone, statoDi,
  segna, registraDaQr, registraImpresaIgnota, aggiungiPersona,
  creaLinkSquadra, revocaLinkSquadra, squadra, segnaDaSquadra, aggiungiDaSquadra, tuttiFuori, personeDelSub,
  segnaDaUfficio, annulla, chiudiIgnota, impreseOggi, altreImpreseAdesso, cantiereDellAzienda,
  // per i test
  statoPersone, documentiImpresa,
};
