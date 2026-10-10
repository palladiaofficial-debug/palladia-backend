'use strict';
/**
 * lib/pioggiaDaConfermare.js — F-318 (AUDIT.md del frontend), "Pioggia da confermare".
 *
 * Decisione del titolare (2026-10-09): la pioggia la decide lui, con un tocco.
 * Palladia propone, per cantiere e giorno:
 *   - chi è uscito prima dicendo "Piove" (presence_log_reasons da_confermare)
 *     e quante ore di pioggia ha (stesso calcolo del foglio del mese: le ore che
 *     mancano alle 8 della giornata, quindi un rientro dopo la pioggia è già contato);
 *   - nelle giornate di pioggia senza nessuna timbratura nel cantiere, chi di
 *     solito ci lavora (giornata intera di maltempo, 8 ore);
 *   - il dato meteo del giorno (site_weather_logs).
 * Conferma = motivi dell'operaio confermati + giornate intere come assenza
 * "maltempo" + la stessa sospensione legale della scheda Meteo
 * (lib/weatherSuspension.js). Scarta = motivi scartati + "non era maltempo".
 * Annulla = tutto torna come prima.
 *
 * F-322: nei giorni di pioggia chi è uscito almeno un'ora prima del solito
 * SENZA rispondere alla domanda (stessa regola della domanda: lib/uscitaAnticipata.js)
 * entra nella proposta come se avesse detto "Piove". Prima quel giorno risultava
 * "lavorato" e finiva in "Nessuna ora di pioggia" (Corso Sardegna 88, 7/10).
 * Alla conferma il motivo lo scrive il titolare (da_lavoratore = false).
 */
const supabase = require('./supabase');
const { buildWorkerHoursReport } = require('../services/workerHoursReport');
const { confirmSuspension, dismissSuspension, undoSuspension, loadSite } = require('./weatherSuspension');
const { ORE_GIORNO_MIN } = require('./oreMese');
const { inAPezzi } = require('./inAPezzi');
const { abitudini, abitudiniDaLog, decidi, romeMinutes } = require('./uscitaAnticipata');

const WINDOW_DAYS = 30;
// F-319: motivi da confermare come la pioggia. 'ritardo_maltempo' = "pioveva"
// all'entrata in ritardo; 'caldo' = card a parte (nessuna sospensione automatica:
// il caldo va registrato nel Registro Caldo del cantiere, da Worklimate).
const METEO_REASONS = ['maltempo', 'ritardo_maltempo', 'caldo'];
const kindOf = (reason) => (reason === 'caldo' ? 'caldo' : 'pioggia');
const USUAL_DAYS = 14; // "di solito lavora qui" = ha timbrato in questo cantiere nelle 2 settimane prima

const romeDay = (iso) => new Date(iso).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
const romeHm = (iso) => new Date(iso).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false });
function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// Finestra larga di 2 ore per l'ora legale, poi filtro sul giorno italiano
const dayStartIso = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 2 * 3600e3).toISOString();
const dayEndIso = (day) => new Date(Date.parse(`${day}T23:59:59Z`) + 2 * 3600e3).toISOString();

async function pendingReasons(companyId, siteId = null, day = null, kind = null) {
  const { data, error } = await supabase.from('presence_log_reasons')
    .select('id, reason, presence_log_id, created_at, presence_logs!inner(id, worker_id, site_id, event_type, timestamp_server, workers(full_name))')
    .eq('company_id', companyId).in('reason', METEO_REASONS).eq('stato', 'da_confermare').eq('da_lavoratore', true)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(r => ({
    id: r.id, motivo: r.reason, kind: kindOf(r.reason), evento: r.presence_logs.event_type,
    logId: r.presence_log_id, workerId: r.presence_logs.worker_id, siteId: r.presence_logs.site_id,
    nome: r.presence_logs.workers?.full_name || '', at: r.presence_logs.timestamp_server, day: romeDay(r.presence_logs.timestamp_server),
  })).filter(r => (!siteId || r.siteId === siteId) && (!day || r.day === day) && (!kind || r.kind === kind));
}

/** Chi di solito lavora nel cantiere e quel giorno non ha timbrato né ha un'assenza. */
async function attesiNelCantiere(companyId, siteId, day) {
  const [prima, quelGiorno, assenze] = await Promise.all([
    supabase.from('presence_logs').select('worker_id').eq('company_id', companyId).eq('site_id', siteId).eq('event_type', 'ENTRY')
      .gte('timestamp_server', dayStartIso(addDays(day, -USUAL_DAYS))).lt('timestamp_server', dayStartIso(day)).limit(5000),
    supabase.from('presence_logs').select('worker_id, timestamp_server').eq('company_id', companyId)
      .gte('timestamp_server', dayStartIso(day)).lte('timestamp_server', dayEndIso(day)).limit(5000),
    supabase.from('worker_absences').select('worker_id').eq('company_id', companyId).eq('stato', 'approvata')
      .lte('date_from', day).gte('date_to', day),
  ]);
  for (const r of [prima, quelGiorno, assenze]) if (r.error) throw new Error(r.error.message);
  const timbrato = new Set((quelGiorno.data || []).filter(l => romeDay(l.timestamp_server) === day).map(l => l.worker_id));
  const assente = new Set((assenze.data || []).map(a => a.worker_id));
  const ids = [...new Set((prima.data || []).map(l => l.worker_id))].filter(id => !timbrato.has(id) && !assente.has(id));
  if (!ids.length) return [];
  const ws = await inAPezzi(ids, (b) => supabase.from('workers').select('id, full_name').in('id', b).eq('company_id', companyId).eq('is_active', true));
  return ws.map(w => ({ workerId: w.id, nome: w.full_name, oreMin: ORE_GIORNO_MIN })).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
}

/** F-322: chi quel giorno è uscito presto dal cantiere, non è rientrato e non ha dato un motivo. */
/**
 * Abitudini di tutti gli operai dell'azienda con UNA lettura delle timbrature
 * degli ultimi 35 giorni (prima: una query per operaio, ~5 secondi in Ore e
 * assenze). Map(workerId → Promise di abitudini), come il memo qui sotto.
 */
async function abitudiniAzienda(companyId, now = new Date()) {
  const since = new Date(now.getTime() - 35 * 864e5).toISOString();
  const perOperaio = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('presence_logs').select('worker_id, event_type, timestamp_server')
      .eq('company_id', companyId).gte('timestamp_server', since)
      .order('timestamp_server', { ascending: true }).order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const l of data || []) {
      if (!perOperaio.has(l.worker_id)) perOperaio.set(l.worker_id, []);
      perOperaio.get(l.worker_id).push(l);
    }
    if (!data || data.length < 1000) break;
  }
  const memo = new Map();
  for (const [id, logs] of perOperaio) memo.set(id, Promise.resolve(abitudiniDaLog(logs, now)));
  return memo;
}

// memo = Map condivisa nella stessa chiamata: le abitudini di un operaio si leggono una volta sola
async function uscitePrestoSenzaRisposta(companyId, siteId, day, memo = new Map()) {
  const { data, error } = await supabase.from('presence_logs').select('id, worker_id, event_type, timestamp_server, workers(full_name)')
    .eq('company_id', companyId).eq('site_id', siteId)
    .gte('timestamp_server', dayStartIso(day)).lte('timestamp_server', dayEndIso(day))
    .order('timestamp_server', { ascending: true }).limit(2000);
  if (error) throw new Error(error.message);
  const ultimo = new Map();
  for (const l of data || []) if (romeDay(l.timestamp_server) === day) ultimo.set(l.worker_id, l);
  const uscite = [...ultimo.values()].filter(l => l.event_type === 'EXIT');
  if (!uscite.length) return [];
  const motivi = await inAPezzi(uscite.map(l => l.id), (b) => supabase.from('presence_log_reasons').select('presence_log_id').in('presence_log_id', b));
  const conMotivo = new Set(motivi.map(m => m.presence_log_id));
  const out = [];
  for (const l of uscite) {
    if (conMotivo.has(l.id)) continue;
    if (!memo.has(l.worker_id)) memo.set(l.worker_id, abitudini(companyId, l.worker_id));
    if (!decidi(await memo.get(l.worker_id), romeMinutes(l.timestamp_server)).ask) continue;
    out.push({ id: null, motivo: 'maltempo', kind: 'pioggia', evento: 'EXIT', logId: l.id, workerId: l.worker_id, siteId,
      nome: l.workers?.full_name || '', at: l.timestamp_server, day, senzaRisposta: true });
  }
  return out;
}

async function siteHadPunches(companyId, siteId, day) {
  const { data } = await supabase.from('presence_logs').select('timestamp_server').eq('company_id', companyId).eq('site_id', siteId)
    .gte('timestamp_server', dayStartIso(day)).lte('timestamp_server', dayEndIso(day)).limit(200);
  return (data || []).some(l => romeDay(l.timestamp_server) === day);
}

/** Le proposte da confermare, una per cantiere e giorno. */
async function proposte(companyId, { today = romeDay(new Date().toISOString()) } = {}) {
  const since = addDays(today, -WINDOW_DAYS);
  const [reasons, logsRes, sitesRes] = await Promise.all([
    pendingReasons(companyId),
    supabase.from('site_weather_logs').select('site_id, log_date, precipitation_mm, wind_max_kmh, weather_desc, threshold_reason')
      .eq('company_id', companyId).eq('threshold_exceeded', true).eq('suspension_confirmed', false).eq('suspension_dismissed', false)
      .gte('log_date', since).lte('log_date', today),
    supabase.from('sites').select('id, name, status').eq('company_id', companyId),
  ]);
  if (logsRes.error) throw new Error(logsRes.error.message);
  const sites = new Map((sitesRes.data || []).map(s => [s.id, s]));
  const groups = new Map();
  const g = (siteId, day, kind) => {
    const k = `${siteId}|${day}|${kind}`;
    if (!groups.has(k)) groups.set(k, { siteId, day, kind, cantiere: sites.get(siteId)?.name || 'Cantiere', meteo: null, persone: [], giornataIntera: [] });
    return groups.get(k);
  };
  for (const r of reasons) if (r.day >= since) g(r.siteId, r.day, r.kind).persone.push(r);
  for (const l of logsRes.data || []) {
    if (!sites.has(l.site_id) || !['attivo', 'sospeso'].includes(sites.get(l.site_id).status)) continue;
    g(l.site_id, l.log_date, 'pioggia').meteo = { mm: l.precipitation_mm, ventoKmh: l.wind_max_kmh, descrizione: l.weather_desc, motivo: l.threshold_reason };
  }
  // Meteo di giorni con persone ma senza soglia superata: lo mostriamo lo stesso, se c'è
  const senzaMeteo = [...groups.values()].filter(x => !x.meteo && x.kind === 'pioggia');
  if (senzaMeteo.length) {
    const { data: extra } = await supabase.from('site_weather_logs').select('site_id, log_date, precipitation_mm, wind_max_kmh, weather_desc')
      .eq('company_id', companyId).in('site_id', [...new Set(senzaMeteo.map(x => x.siteId))]).in('log_date', [...new Set(senzaMeteo.map(x => x.day))]);
    for (const l of extra || []) { const x = groups.get(`${l.site_id}|${l.log_date}|pioggia`); if (x) x.meteo = { mm: l.precipitation_mm, ventoKmh: l.wind_max_kmh, descrizione: l.weather_desc, sottoSoglia: true }; }
  }

  // F-322: giorni di pioggia dove nessuno ha risposto ma qualcuno è uscito presto
  const memo = await abitudiniAzienda(companyId);
  await Promise.all([...groups.values()]
    .filter(x => x.kind === 'pioggia' && !x.persone.length && x.meteo && !x.meteo.sottoSoglia && x.day <= today)
    .map(async (x) => { x.persone = await uscitePrestoSenzaRisposta(companyId, x.siteId, x.day, memo); }));

  // Ore di pioggia di chi è uscito: stesso calcolo del foglio del mese
  const conPersone = [...groups.values()].filter(x => x.persone.length);
  if (conPersone.length) {
    const days = conPersone.map(x => x.day).sort();
    const report = await buildWorkerHoursReport(null, companyId, days[0], days[days.length - 1], null, true);
    const worked = new Map();
    for (const w of report.workers || []) for (const d of w.days || []) worked.set(`${w.id}|${d.date_key}`, d.day_total_minutes || 0);
    const entries = await inAPezzi(conPersone.flatMap(x => x.persone.map(p => p.workerId)), (b) => supabase.from('presence_logs').select('worker_id, timestamp_server')
      .eq('company_id', companyId).eq('event_type', 'ENTRY').in('worker_id', b)
      .gte('timestamp_server', dayStartIso(days[0])).lte('timestamp_server', dayEndIso(days[days.length - 1])));
    for (const x of conPersone) {
      x.persone = x.persone.map(p => {
        const oreMin = Math.max(0, ORE_GIORNO_MIN - (worked.get(`${p.workerId}|${p.day}`) || 0));
        // F-319: "pioveva" all'entrata in ritardo
        if (p.evento === 'ENTRY') return { reasonId: p.id, workerId: p.workerId, nome: p.nome, entrata: romeHm(p.at), uscita: null, rientro: null, oreMin };
        const rientro = (entries || []).filter(e => e.worker_id === p.workerId && e.timestamp_server > p.at && romeDay(e.timestamp_server) === p.day)
          .sort((a, b) => a.timestamp_server.localeCompare(b.timestamp_server))[0];
        return { reasonId: p.id, workerId: p.workerId, nome: p.nome, entrata: null, uscita: romeHm(p.at), rientro: rientro ? romeHm(rientro.timestamp_server) : null, oreMin, ...(p.senzaRisposta ? { senzaRisposta: true } : {}) };
      });
    }
  }
  // Giornata intera: soglia superata e nessuno ha timbrato nel cantiere
  await Promise.all([...groups.values()]
    .filter(x => x.kind === 'pioggia' && !x.persone.length && x.meteo && !x.meteo.sottoSoglia && x.day <= today)
    .map(async (x) => {
      x.nessunaTimbratura = !(await siteHadPunches(companyId, x.siteId, x.day));
      if (x.nessunaTimbratura) x.giornataIntera = await attesiNelCantiere(companyId, x.siteId, x.day);
    }));
  // Tipo: le prime due sono decisioni vere (una card ciascuna); le altre due
  // sono pioggerella dove si è lavorato o cantieri dove non c'era nessuno,
  // che il titolare chiude tutte insieme con "Nessuna ora di pioggia".
  for (const x of groups.values()) {
    x.tipo = x.persone.length ? 'uscite' : x.giornataIntera.length ? 'giornata' : x.nessunaTimbratura ? 'vuoto' : 'lavorato';
  }
  return [...groups.values()].sort((a, b) => b.day.localeCompare(a.day) || a.cantiere.localeCompare(b.cantiere, 'it'));
}

/** "Nessuna ora di pioggia" per tutte le giornate dove si è lavorato o non c'era nessuno. */
async function scartaSenzaOre({ companyId, userId = null }) {
  const lista = (await proposte(companyId)).filter(x => x.kind === 'pioggia' && (x.tipo === 'lavorato' || x.tipo === 'vuoto'));
  const fatti = [];
  for (const x of lista) {
    try { fatti.push(await scarta({ companyId, siteId: x.siteId, day: x.day, userId })); }
    catch (e) { if (!(e instanceof PioggiaError) || e.status >= 500) throw e; }
  }
  return { fatti };
}

class PioggiaError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

async function sitoDellAzienda(companyId, siteId) {
  const site = await loadSite(siteId, companyId);
  if (!site) throw new PioggiaError('SITE_NOT_FOUND', 404);
  return site;
}

async function weatherLog(siteId, day) {
  const { data } = await supabase.from('site_weather_logs').select('id, suspension_confirmed, suspension_dismissed').eq('site_id', siteId).eq('log_date', day).maybeSingle();
  return data;
}

/** "Conferma": ritorna cosa è stato fatto, per poterlo annullare. */
async function conferma({ companyId, siteId, day, kind = 'pioggia', userId = null, today = romeDay(new Date().toISOString()) }) {
  if (!isDay(day) || day > today) throw new PioggiaError('INVALID_DAY');
  if (!['pioggia', 'caldo'].includes(kind)) throw new PioggiaError('INVALID_KIND');
  const site = await sitoDellAzienda(companyId, siteId);
  const reasons = await pendingReasons(companyId, siteId, day, kind);
  const now = new Date().toISOString();
  let reasonIds = [];
  if (reasons.length) {
    const { data, error } = await supabase.from('presence_log_reasons')
      .update({ stato: 'confermato', decided_by: userId, decided_at: now })
      .in('id', reasons.map(r => r.id)).eq('company_id', companyId).eq('stato', 'da_confermare').select('id');
    if (error) throw new PioggiaError('DB_ERROR', 500);
    reasonIds = (data || []).map(r => r.id);
  }
  // F-322: chi è uscito presto senza rispondere — il motivo lo scrive il titolare
  let nuoviMotivi = [];
  if (kind === 'pioggia' && !reasons.length) {
    const senza = await uscitePrestoSenzaRisposta(companyId, siteId, day);
    if (senza.length) {
      const { data, error } = await supabase.from('presence_log_reasons').insert(senza.map(p => ({
        company_id: companyId, presence_log_id: p.logId, reason: 'maltempo', stato: 'confermato', da_lavoratore: false,
        created_by: userId, decided_by: userId, decided_at: now, note: `Pioggia confermata dal titolare · ${site.name}`,
      }))).select('id');
      if (error) throw new PioggiaError('DB_ERROR', 500);
      nuoviMotivi = (data || []).map(r => r.id);
    }
  }
  let absenceIds = [];
  if (kind === 'pioggia' && !reasons.length && !nuoviMotivi.length && !(await siteHadPunches(companyId, siteId, day))) {
    const attesi = await attesiNelCantiere(companyId, siteId, day);
    if (attesi.length) {
      const { data, error } = await supabase.from('worker_absences').insert(attesi.map(a => ({
        company_id: companyId, worker_id: a.workerId, tipo: 'maltempo', date_from: day, date_to: day,
        site_id: siteId, ore_min: a.oreMin, stato: 'approvata', da_lavoratore: false, created_by: userId,
        note: `Giornata di pioggia confermata · ${site.name}`,
      }))).select('id');
      if (error) throw new PioggiaError('DB_ERROR', 500);
      absenceIds = (data || []).map(r => r.id);
    }
  }
  let sospensione = false;
  const log = kind === 'pioggia' ? await weatherLog(siteId, day) : null;
  if (log && !log.suspension_confirmed && !log.suspension_dismissed) {
    const r = await confirmSuspension({ companyId, site, date: day, notes: 'Confermata da Ore e assenze', userId });
    if (r.status !== 200) throw new PioggiaError(r.body.error || 'DB_ERROR', r.status);
    sospensione = true;
  }
  if (!reasonIds.length && !nuoviMotivi.length && !absenceIds.length && !sospensione) throw new PioggiaError('NOTHING_TO_CONFIRM', 409);
  return { siteId, day, kind, reasonIds, nuoviMotivi, absenceIds, sospensione };
}

/** "Non era pioggia". */
async function scarta({ companyId, siteId, day, kind = 'pioggia', userId = null }) {
  if (!isDay(day)) throw new PioggiaError('INVALID_DAY');
  const site = await sitoDellAzienda(companyId, siteId);
  const reasons = await pendingReasons(companyId, siteId, day, kind);
  let reasonIds = [];
  if (reasons.length) {
    const { data, error } = await supabase.from('presence_log_reasons')
      .update({ stato: 'scartato', decided_by: userId, decided_at: new Date().toISOString() })
      .in('id', reasons.map(r => r.id)).eq('company_id', companyId).eq('stato', 'da_confermare').select('id');
    if (error) throw new PioggiaError('DB_ERROR', 500);
    reasonIds = (data || []).map(r => r.id);
  }
  let scartata = false;
  const log = kind === 'pioggia' ? await weatherLog(siteId, day) : null;
  if (log && !log.suspension_confirmed && !log.suspension_dismissed) {
    const r = await dismissSuspension({ companyId, site, date: day });
    if (r.status !== 200) throw new PioggiaError(r.body.error || 'DB_ERROR', r.status);
    scartata = true;
  }
  if (!reasonIds.length && !scartata) throw new PioggiaError('NOTHING_TO_DISMISS', 409);
  return { siteId, day, kind, reasonIds, absenceIds: [], sospensione: false, scartata };
}

/** "Annulla" dopo una conferma o uno scarto: tutto torna da confermare. */
async function annulla({ companyId, siteId, day, reasonIds = [], nuoviMotivi = [], absenceIds = [], sospensione = false, scartata = false }) {
  if (!isDay(day)) throw new PioggiaError('INVALID_DAY');
  const site = await sitoDellAzienda(companyId, siteId);
  if (nuoviMotivi.length) {
    const { error } = await supabase.from('presence_log_reasons').delete()
      .in('id', nuoviMotivi).eq('company_id', companyId).eq('reason', 'maltempo').eq('da_lavoratore', false);
    if (error) throw new PioggiaError('DB_ERROR', 500);
  }
  if (reasonIds.length) {
    const { error } = await supabase.from('presence_log_reasons').update({ stato: 'da_confermare', decided_by: null, decided_at: null })
      .in('id', reasonIds).eq('company_id', companyId).in('reason', METEO_REASONS).eq('da_lavoratore', true);
    if (error) throw new PioggiaError('DB_ERROR', 500);
  }
  if (absenceIds.length) {
    const { error } = await supabase.from('worker_absences').delete()
      .in('id', absenceIds).eq('company_id', companyId).eq('tipo', 'maltempo').eq('site_id', siteId).eq('date_from', day);
    if (error) throw new PioggiaError('DB_ERROR', 500);
  }
  if (sospensione || scartata) {
    const r = await undoSuspension({ companyId, site, date: day, allowDismissed: scartata });
    if (r.status !== 200 && r.status !== 409) throw new PioggiaError(r.body.error || 'DB_ERROR', r.status);
  }
  return { ok: true };
}

// ── Pausa pranzo saltata (F-319) ─────────────────────────────────────────────
// L'operaio dice "Ho saltato la pausa" uscendo fino a 90 minuti prima; il
// titolare conferma: si scrive presence_lunch_overrides ("niente pausa oggi"),
// già letto dal calcolo ore, quindi quel giorno l'ora di pranzo non si toglie.
async function pauseDaConfermare(companyId) {
  const { data, error } = await supabase.from('presence_log_reasons')
    .select('id, created_at, presence_logs!inner(id, worker_id, site_id, timestamp_server, workers(full_name))')
    .eq('company_id', companyId).eq('reason', 'pausa_saltata').eq('stato', 'da_confermare').eq('da_lavoratore', true)
    .gte('created_at', new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString())
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  // presence_logs non ha la relazione con sites (F-206): nomi letti a parte
  const siteIds = [...new Set((data || []).map(r => r.presence_logs.site_id).filter(Boolean))];
  const { data: sites } = siteIds.length ? await supabase.from('sites').select('id, name').in('id', siteIds) : { data: [] };
  const siteName = new Map((sites || []).map(x => [x.id, x.name]));
  return (data || []).map(r => ({
    reasonId: r.id, workerId: r.presence_logs.worker_id, nome: r.presence_logs.workers?.full_name || '',
    cantiere: siteName.get(r.presence_logs.site_id) || '', day: romeDay(r.presence_logs.timestamp_server), uscita: romeHm(r.presence_logs.timestamp_server),
  }));
}

async function pausaRow(companyId, reasonId) {
  const { data } = await supabase.from('presence_log_reasons')
    .select('id, stato, lunch_override_id, presence_logs!inner(worker_id, timestamp_server)')
    .eq('id', reasonId).eq('company_id', companyId).eq('reason', 'pausa_saltata').maybeSingle();
  if (!data) throw new PioggiaError('NOT_FOUND', 404);
  return data;
}

async function confermaPausa({ companyId, reasonId, userId = null }) {
  const row = await pausaRow(companyId, reasonId);
  if (row.stato !== 'da_confermare') throw new PioggiaError('ALREADY_DECIDED', 409);
  const workDate = romeDay(row.presence_logs.timestamp_server);
  // Se "niente pausa oggi" c'è già (messo dall'ufficio), non se ne crea un altro
  const { data: existing } = await supabase.from('presence_lunch_overrides').select('id')
    .eq('worker_id', row.presence_logs.worker_id).eq('work_date', workDate).maybeSingle();
  let overrideId = null;
  if (!existing) {
    const { data: ins, error } = await supabase.from('presence_lunch_overrides').insert({
      company_id: companyId, worker_id: row.presence_logs.worker_id, work_date: workDate,
      note: 'Pausa saltata: detto dall\'operaio, confermato dal titolare', created_by: userId,
    }).select('id').single();
    if (error) throw new PioggiaError('DB_ERROR', 500);
    overrideId = ins.id;
  }
  const { error: uErr } = await supabase.from('presence_log_reasons')
    .update({ stato: 'confermato', decided_by: userId, decided_at: new Date().toISOString(), lunch_override_id: overrideId })
    .eq('id', reasonId).eq('company_id', companyId);
  if (uErr) throw new PioggiaError('DB_ERROR', 500);
  return { pausa: true, reasonId, overrideId };
}

async function scartaPausa({ companyId, reasonId, userId = null }) {
  const row = await pausaRow(companyId, reasonId);
  if (row.stato !== 'da_confermare') throw new PioggiaError('ALREADY_DECIDED', 409);
  const { error } = await supabase.from('presence_log_reasons')
    .update({ stato: 'scartato', decided_by: userId, decided_at: new Date().toISOString() }).eq('id', reasonId).eq('company_id', companyId);
  if (error) throw new PioggiaError('DB_ERROR', 500);
  return { pausa: true, reasonId, overrideId: null };
}

async function annullaPausa({ companyId, reasonId }) {
  const row = await pausaRow(companyId, reasonId);
  if (row.lunch_override_id) {
    const { error } = await supabase.from('presence_lunch_overrides').delete().eq('id', row.lunch_override_id).eq('company_id', companyId);
    if (error) throw new PioggiaError('DB_ERROR', 500);
  }
  const { error } = await supabase.from('presence_log_reasons')
    .update({ stato: 'da_confermare', decided_by: null, decided_at: null, lunch_override_id: null }).eq('id', reasonId).eq('company_id', companyId);
  if (error) throw new PioggiaError('DB_ERROR', 500);
  return { ok: true };
}

module.exports = { proposte, conferma, scarta, scartaSenzaOre, annulla, pauseDaConfermare, confermaPausa, scartaPausa, annullaPausa, PioggiaError };
