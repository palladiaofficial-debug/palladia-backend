'use strict';
// ── Chi non ha timbrato oggi (F-285, richiesta del titolare 2026-10-05) ──────
// "Adesso non si capisce chi manchi, bisogna controllare uno per uno."
// Mancante = lavoratore attivo che ha timbrato almeno una volta negli ultimi
// 14 giorni e oggi no. Chi non timbra mai (ufficio, titolare) non compare:
// sarebbe in elenco tutti i giorni. Chi ha ferie/permesso/malattia approvati
// per oggi compare a parte, con il motivo, non tra i mancanti.
const supabase = require('./supabase');
const { romeDate, addDays } = require('./daFare');
const { romeAt } = require('./usualTimes');

const LOOKBACK_DAYS = 14;

async function missingToday(companyId, { today = romeDate() } = {}) {
  const since = romeAt(addDays(today, -LOOKBACK_DAYS), 0);
  const todayStart = romeAt(today, 0);
  const [wRes, lRes, aRes] = await Promise.all([
    supabase.from('workers').select('id, full_name, pending_approval').eq('company_id', companyId).eq('is_active', true),
    supabase.from('presence_logs').select('worker_id, timestamp_server, site_id')
      .eq('company_id', companyId).gte('timestamp_server', since)
      .order('timestamp_server', { ascending: false }).limit(20000),
    supabase.from('worker_absences').select('worker_id, tipo')
      .eq('company_id', companyId).eq('stato', 'approvata').lte('date_from', today).gte('date_to', today),
  ]);
  for (const r of [wRes, lRes, aRes]) if (r.error) throw new Error(r.error.message);

  const last = new Map();      // ultima timbratura prima di oggi, per lavoratore
  const punchedToday = new Set();
  for (const l of lRes.data || []) {
    if (l.timestamp_server >= todayStart) { punchedToday.add(l.worker_id); continue; }
    if (!last.has(l.worker_id)) last.set(l.worker_id, l);
  }
  const absence = new Map((aRes.data || []).map(a => [a.worker_id, a.tipo]));

  const missing = [], absent = [];
  for (const w of wRes.data || []) {
    if (w.pending_approval || punchedToday.has(w.id) || !last.has(w.id)) continue;
    const row = { worker_id: w.id, full_name: w.full_name, last_at: last.get(w.id).timestamp_server, last_site_id: last.get(w.id).site_id };
    if (absence.has(w.id)) absent.push({ ...row, tipo: absence.get(w.id) });
    else missing.push(row);
  }
  const byName = (a, b) => a.full_name.localeCompare(b.full_name, 'it');
  return { date: today, missing: missing.sort(byName), absent: absent.sort(byName), punched: punchedToday.size };
}

module.exports = { missingToday, LOOKBACK_DAYS };
