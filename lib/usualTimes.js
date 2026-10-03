'use strict';
// ── Orario abituale di un operaio (mockup "Timbrature senza errori", 2026-10-03)
// Mediana dell'ora della prima entrata e dell'ultima uscita sugli ultimi giorni
// lavorati. Serve a: proporre l'orario al titolare ("Uscita alle 17:00"),
// mandare il promemoria d'uscita al momento giusto per QUELL'operaio, non
// fare la domanda del pomeriggio a chi lavora di pomeriggio. Sola lettura.
// Le uscite chiuse in automatico (cron, cambio cantiere) non contano: non sono
// orari veri. Le correzioni del titolare sì.
const supabase = require('./supabase');

const LOOKBACK_DAYS = 28;
const MAX_DAYS = 10;
const MIN_DAYS = 3;
const AUTO_METHODS = ['ladia_action', 'auto_exit_stale_before_reopen', 'auto_exit_on_site_change'];

const romeDay = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
function romeMinutes(t) {
  const [h, m] = new Date(t).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number);
  return h * 60 + m;
}
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
const hhmm = (min) => min == null ? null : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Calcolo puro su una lista di timbrature (testabile senza DB).
 * @returns {{ entryMin: number|null, exitMin: number|null, days: number }}
 */
function usualFromLogs(logs, { beforeDay = null } = {}) {
  const byDay = new Map();
  for (const l of logs) {
    const d = romeDay(l.timestamp_server);
    if (beforeDay && d >= beforeDay) continue;
    if (!byDay.has(d)) byDay.set(d, { entry: null, exit: null });
    const g = byDay.get(d);
    const min = romeMinutes(l.timestamp_server);
    if (l.event_type === 'ENTRY' && (g.entry == null || min < g.entry)) g.entry = min;
    if (l.event_type === 'EXIT' && !AUTO_METHODS.includes(l.method) && (g.exit == null || min > g.exit)) g.exit = min;
  }
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, MAX_DAYS).map(([, g]) => g);
  const entries = days.map(g => g.entry).filter(v => v != null);
  const exits = days.map(g => g.exit).filter(v => v != null);
  return {
    entryMin: entries.length >= MIN_DAYS ? median(entries) : null,
    exitMin: exits.length >= MIN_DAYS ? median(exits) : null,
    days: days.length,
  };
}

/** Orari abituali di uno o più operai (una sola query). Map workerId → { entryMin, exitMin, days }. */
async function usualTimesFor(companyId, workerIds, { today = romeDay(new Date()) } = {}) {
  const out = new Map();
  if (!workerIds.length) return out;
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await supabase.from('presence_logs')
      .select('worker_id, event_type, timestamp_server, method')
      .eq('company_id', companyId).in('worker_id', workerIds)
      .gte('timestamp_server', since).order('timestamp_server').range(from, from + 999);
    if (error) throw new Error(`usualTimesFor: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  for (const id of workerIds) out.set(id, usualFromLogs(all.filter(l => l.worker_id === id), { beforeDay: today }));
  return out;
}

/** Istante (ISO) di oggi/`day` alle `min` minuti, ora italiana. */
function romeAt(day, min) {
  const hm = hhmm(min);
  // Prova i due fusi possibili (CET/CEST): quello che riletto in Italia dà l'ora giusta
  for (const off of ['+02:00', '+01:00']) {
    const d = new Date(`${day}T${hm}:00${off}`);
    if (romeDay(d) === day && romeMinutes(d) === min) return d.toISOString();
  }
  return new Date(`${day}T${hm}:00+01:00`).toISOString();
}

module.exports = { usualFromLogs, usualTimesFor, romeAt, romeDay, romeMinutes, hhmm, AUTO_METHODS };
