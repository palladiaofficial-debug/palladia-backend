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
 */
const supabase = require('./supabase');
const { buildWorkerHoursReport } = require('../services/workerHoursReport');
const { confirmSuspension, dismissSuspension, undoSuspension, loadSite } = require('./weatherSuspension');
const { ORE_GIORNO_MIN } = require('./oreMese');

const WINDOW_DAYS = 30;
const USUAL_DAYS = 14; // "di solito lavora qui" = ha timbrato in questo cantiere nelle 2 settimane prima

const romeDay = (iso) => new Date(iso).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
const romeHm = (iso) => new Date(iso).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false });
function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// Finestra larga di 2 ore per l'ora legale, poi filtro sul giorno italiano
const dayStartIso = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 2 * 3600e3).toISOString();
const dayEndIso = (day) => new Date(Date.parse(`${day}T23:59:59Z`) + 2 * 3600e3).toISOString();

async function pendingReasons(companyId, siteId = null, day = null) {
  const { data, error } = await supabase.from('presence_log_reasons')
    .select('id, presence_log_id, created_at, presence_logs!inner(id, worker_id, site_id, timestamp_server, workers(full_name))')
    .eq('company_id', companyId).eq('reason', 'maltempo').eq('stato', 'da_confermare').eq('da_lavoratore', true)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(r => ({
    id: r.id, logId: r.presence_log_id, workerId: r.presence_logs.worker_id, siteId: r.presence_logs.site_id,
    nome: r.presence_logs.workers?.full_name || '', at: r.presence_logs.timestamp_server, day: romeDay(r.presence_logs.timestamp_server),
  })).filter(r => (!siteId || r.siteId === siteId) && (!day || r.day === day));
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
  const { data: ws } = await supabase.from('workers').select('id, full_name').in('id', ids).eq('company_id', companyId).eq('is_active', true);
  return (ws || []).map(w => ({ workerId: w.id, nome: w.full_name, oreMin: ORE_GIORNO_MIN })).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
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
  const g = (siteId, day) => {
    const k = `${siteId}|${day}`;
    if (!groups.has(k)) groups.set(k, { siteId, day, cantiere: sites.get(siteId)?.name || 'Cantiere', meteo: null, persone: [], giornataIntera: [] });
    return groups.get(k);
  };
  for (const r of reasons) if (r.day >= since) g(r.siteId, r.day).persone.push(r);
  for (const l of logsRes.data || []) {
    if (!sites.has(l.site_id) || !['attivo', 'sospeso'].includes(sites.get(l.site_id).status)) continue;
    g(l.site_id, l.log_date).meteo = { mm: l.precipitation_mm, ventoKmh: l.wind_max_kmh, descrizione: l.weather_desc, motivo: l.threshold_reason };
  }
  // Meteo di giorni con persone ma senza soglia superata: lo mostriamo lo stesso, se c'è
  const senzaMeteo = [...groups.values()].filter(x => !x.meteo);
  if (senzaMeteo.length) {
    const { data: extra } = await supabase.from('site_weather_logs').select('site_id, log_date, precipitation_mm, wind_max_kmh, weather_desc')
      .eq('company_id', companyId).in('site_id', [...new Set(senzaMeteo.map(x => x.siteId))]).in('log_date', [...new Set(senzaMeteo.map(x => x.day))]);
    for (const l of extra || []) { const x = groups.get(`${l.site_id}|${l.log_date}`); if (x) x.meteo = { mm: l.precipitation_mm, ventoKmh: l.wind_max_kmh, descrizione: l.weather_desc, sottoSoglia: true }; }
  }

  // Ore di pioggia di chi è uscito: stesso calcolo del foglio del mese
  const conPersone = [...groups.values()].filter(x => x.persone.length);
  if (conPersone.length) {
    const days = conPersone.map(x => x.day).sort();
    const report = await buildWorkerHoursReport(null, companyId, days[0], days[days.length - 1], null, true);
    const worked = new Map();
    for (const w of report.workers || []) for (const d of w.days || []) worked.set(`${w.id}|${d.date_key}`, d.day_total_minutes || 0);
    const { data: entries } = await supabase.from('presence_logs').select('worker_id, timestamp_server').eq('company_id', companyId).eq('event_type', 'ENTRY')
      .in('worker_id', [...new Set(conPersone.flatMap(x => x.persone.map(p => p.workerId)))])
      .gte('timestamp_server', dayStartIso(days[0])).lte('timestamp_server', dayEndIso(days[days.length - 1]));
    for (const x of conPersone) {
      x.persone = x.persone.map(p => {
        const rientro = (entries || []).filter(e => e.worker_id === p.workerId && e.timestamp_server > p.at && romeDay(e.timestamp_server) === p.day)
          .sort((a, b) => a.timestamp_server.localeCompare(b.timestamp_server))[0];
        return {
          reasonId: p.id, workerId: p.workerId, nome: p.nome, uscita: romeHm(p.at), rientro: rientro ? romeHm(rientro.timestamp_server) : null,
          oreMin: Math.max(0, ORE_GIORNO_MIN - (worked.get(`${p.workerId}|${p.day}`) || 0)),
        };
      });
    }
  }
  // Giornata intera: soglia superata e nessuno ha timbrato nel cantiere
  for (const x of groups.values()) {
    if (x.persone.length || !x.meteo || x.meteo.sottoSoglia || x.day > today) continue;
    x.nessunaTimbratura = !(await siteHadPunches(companyId, x.siteId, x.day));
    if (x.nessunaTimbratura) x.giornataIntera = await attesiNelCantiere(companyId, x.siteId, x.day);
  }
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
  const lista = (await proposte(companyId)).filter(x => x.tipo === 'lavorato' || x.tipo === 'vuoto');
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
async function conferma({ companyId, siteId, day, userId = null, today = romeDay(new Date().toISOString()) }) {
  if (!isDay(day) || day > today) throw new PioggiaError('INVALID_DAY');
  const site = await sitoDellAzienda(companyId, siteId);
  const reasons = await pendingReasons(companyId, siteId, day);
  const now = new Date().toISOString();
  let reasonIds = [];
  if (reasons.length) {
    const { data, error } = await supabase.from('presence_log_reasons')
      .update({ stato: 'confermato', decided_by: userId, decided_at: now })
      .in('id', reasons.map(r => r.id)).eq('company_id', companyId).eq('stato', 'da_confermare').select('id');
    if (error) throw new PioggiaError('DB_ERROR', 500);
    reasonIds = (data || []).map(r => r.id);
  }
  let absenceIds = [];
  if (!reasons.length && !(await siteHadPunches(companyId, siteId, day))) {
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
  const log = await weatherLog(siteId, day);
  if (log && !log.suspension_confirmed && !log.suspension_dismissed) {
    const r = await confirmSuspension({ companyId, site, date: day, notes: 'Confermata da Ore e assenze', userId });
    if (r.status !== 200) throw new PioggiaError(r.body.error || 'DB_ERROR', r.status);
    sospensione = true;
  }
  if (!reasonIds.length && !absenceIds.length && !sospensione) throw new PioggiaError('NOTHING_TO_CONFIRM', 409);
  return { siteId, day, reasonIds, absenceIds, sospensione };
}

/** "Non era pioggia". */
async function scarta({ companyId, siteId, day, userId = null }) {
  if (!isDay(day)) throw new PioggiaError('INVALID_DAY');
  const site = await sitoDellAzienda(companyId, siteId);
  const reasons = await pendingReasons(companyId, siteId, day);
  let reasonIds = [];
  if (reasons.length) {
    const { data, error } = await supabase.from('presence_log_reasons')
      .update({ stato: 'scartato', decided_by: userId, decided_at: new Date().toISOString() })
      .in('id', reasons.map(r => r.id)).eq('company_id', companyId).eq('stato', 'da_confermare').select('id');
    if (error) throw new PioggiaError('DB_ERROR', 500);
    reasonIds = (data || []).map(r => r.id);
  }
  let scartata = false;
  const log = await weatherLog(siteId, day);
  if (log && !log.suspension_confirmed && !log.suspension_dismissed) {
    const r = await dismissSuspension({ companyId, site, date: day });
    if (r.status !== 200) throw new PioggiaError(r.body.error || 'DB_ERROR', r.status);
    scartata = true;
  }
  if (!reasonIds.length && !scartata) throw new PioggiaError('NOTHING_TO_DISMISS', 409);
  return { siteId, day, reasonIds, absenceIds: [], sospensione: false, scartata };
}

/** "Annulla" dopo una conferma o uno scarto: tutto torna da confermare. */
async function annulla({ companyId, siteId, day, reasonIds = [], absenceIds = [], sospensione = false, scartata = false }) {
  if (!isDay(day)) throw new PioggiaError('INVALID_DAY');
  const site = await sitoDellAzienda(companyId, siteId);
  if (reasonIds.length) {
    const { error } = await supabase.from('presence_log_reasons').update({ stato: 'da_confermare', decided_by: null, decided_at: null })
      .in('id', reasonIds).eq('company_id', companyId).eq('reason', 'maltempo').eq('da_lavoratore', true);
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

module.exports = { proposte, conferma, scarta, scartaSenzaOre, annulla, PioggiaError };
