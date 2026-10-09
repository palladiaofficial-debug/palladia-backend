'use strict';
// ── Ore e assenze del mese (F-265, AUDIT.md del frontend) ───────────────────
// Riepilogo per lavoratore e giorno: ore timbrate, straordinario, ferie,
// permessi, malattia, maltempo, giorni da giustificare.
//
// Regola non negoziabile: qui si LEGGE soltanto. Le ore vengono da
// buildWorkerHoursReport (lo stesso calcolo dei report esistenti, con pausa
// pranzo, ritardi e motivi d'uscita già applicati) e le assenze da
// worker_absences. Niente in questo modulo scrive presence_logs o passa
// qualcosa a lib/presencePairing.js.
const supabase = require('./supabase');
const { buildWorkerHoursReport } = require('../services/workerHoursReport');
const { REASON_LABEL } = require('./presenceLogReasons');

const ORE_GIORNO_MIN = 480; // 8 ore: oltre è straordinario (come i report esistenti)

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }

/** Pasqua (algoritmo di Gauss/Meeus), per il Lunedì dell'Angelo. */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}

/** Festività nazionali italiane dell'anno (YYYY-MM-DD → nome). */
function festivita(y) {
  const out = {
    [ymd(y, 1, 1)]: 'Capodanno', [ymd(y, 1, 6)]: 'Epifania', [ymd(y, 4, 25)]: 'Liberazione',
    [ymd(y, 5, 1)]: 'Festa dei lavoratori', [ymd(y, 6, 2)]: 'Festa della Repubblica', [ymd(y, 8, 15)]: 'Ferragosto',
    [ymd(y, 11, 1)]: 'Ognissanti', [ymd(y, 12, 8)]: 'Immacolata', [ymd(y, 12, 25)]: 'Natale', [ymd(y, 12, 26)]: 'Santo Stefano',
  };
  const em = easter(y); em.setUTCDate(em.getUTCDate() + 1);
  out[em.toISOString().slice(0, 10)] = 'Lunedì dell’Angelo';
  return out;
}

const toMin = (t) => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };

/** Motivi d'uscita del giorno, dalle note del report (etichette di REASON_LABEL). */
function reasonsOfDay(day) {
  const text = (day.entries || []).map(e => e.anomaly || '').join(' | ');
  const out = new Set();
  for (const [code, label] of Object.entries(REASON_LABEL)) if (text.includes(label)) out.add(code);
  return out;
}

/**
 * @param {string} companyId
 * @param {string} month  'YYYY-MM'
 * @param {{ today?: string }} [opts]  oggi (YYYY-MM-DD, per i test); i giorni futuri non sono "da giustificare"
 */
async function buildOreMese(companyId, month, opts = {}) {
  if (!/^\d{4}-\d{2}$/.test(month)) { const e = new Error('month deve essere YYYY-MM'); e.status = 400; throw e; }
  const [y, m] = month.split('-').map(Number);
  const nDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = ymd(y, m, 1), to = ymd(y, m, nDays);
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const hol = festivita(y);

  const days = [];
  for (let d = 1; d <= nDays; d++) {
    const key = ymd(y, m, d);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    days.push({ date: key, day: d, dow, weekend: dow === 0 || dow === 6, festivo: hol[key] || null });
  }

  const [report, absRes] = await Promise.all([
    buildWorkerHoursReport(null, companyId, from, to, null, true),
    supabase.from('worker_absences')
      .select('id, worker_id, tipo, date_from, date_to, ora_dalle, ora_alle, protocollo, note, stato, da_lavoratore, created_at, site_id, ore_min')
      .eq('company_id', companyId).lte('date_from', to).gte('date_to', from).order('date_from'),
  ]);
  if (absRes.error) { const e = new Error(absRes.error.message); e.status = 500; throw e; }
  const absences = absRes.data || [];
  const approved = absences.filter(a => a.stato === 'approvata');

  // Lavoratori: chi ha timbrato nel mese + chi ha un'assenza registrata
  const byId = new Map(report.workers.map(w => [w.id, { id: w.id, nome: w.full_name, reportDays: new Map(w.days.map(d => [d.date_key, d])) }]));
  const missing = [...new Set(absences.map(a => a.worker_id))].filter(id => !byId.has(id));
  if (missing.length) {
    const { data: ws } = await supabase.from('workers').select('id, full_name, first_name, last_name').in('id', missing).eq('company_id', companyId);
    for (const w of ws || []) byId.set(w.id, { id: w.id, nome: w.full_name || [w.first_name, w.last_name].filter(Boolean).join(' '), reportDays: new Map() });
  }

  const lavoratori = [];
  for (const w of byId.values()) {
    const tot = { ordinarieMin: 0, straordMin: 0, ferieGiorni: 0, permessoMin: 0, malattiaGiorni: 0, malattiaMin: 0, maltempoMin: 0, infortunioMin: 0, altroGiorni: 0, daGiustificare: 0, anomalie: 0 };
    const hasPresence = w.reportDays.size > 0;
    const cells = days.map((d) => {
      const rd = w.reportDays.get(d.date);
      const worked = rd ? rd.day_total_minutes : 0;
      const abs = approved.find(a => a.worker_id === w.id && a.date_from <= d.date && a.date_to >= d.date);
      const reasons = rd ? reasonsOfDay(rd) : new Set();
      const cell = { date: d.date, ore: worked, straord: Math.max(0, worked - ORE_GIORNO_MIN), tipo: null, permessoMin: 0, maltempoMin: 0, malattiaMin: 0, infortunioMin: 0, anomalia: !!(rd && rd.entries.some(e => e.anomaly && /non registrata/.test(e.anomaly))), pausaMin: rd ? rd.lunch_break_minutes : 0, assenzaId: abs?.id || null };
      const residuo = Math.max(0, ORE_GIORNO_MIN - worked);
      const lavorativo = !d.weekend && !d.festivo;

      if (abs && abs.tipo === 'maltempo') {
        // F-318: giornata (o parte) di pioggia confermata dal titolare senza timbrature
        cell.maltempoMin = Math.min(abs.ore_min || residuo, residuo); cell.tipo = worked > 0 ? 'lavoro' : 'maltempo';
      } else if (abs && abs.tipo === 'permesso') {
        const dur = abs.ora_dalle && abs.ora_alle ? Math.max(0, toMin(abs.ora_alle) - toMin(abs.ora_dalle)) : residuo;
        cell.permessoMin = dur; cell.tipo = worked > 0 ? 'lavoro' : 'permesso';
      } else if (abs && lavorativo) {
        cell.tipo = abs.tipo; // ferie | malattia | altro
      } else if (worked > 0) {
        cell.tipo = 'lavoro';
        // F-319: il caldo e la pioggia del mattino (entrata in ritardo) sono ore di maltempo;
        // la visita medica e il permesso del mattino sono ore di permesso
        if ((reasons.has('maltempo') || reasons.has('caldo') || reasons.has('ritardo_maltempo')) && lavorativo) cell.maltempoMin = residuo;
        else if ((reasons.has('permesso') || reasons.has('ritardo_permesso') || reasons.has('visita_medica')) && lavorativo) cell.permessoMin = residuo;
        else if (reasons.has('malattia') && lavorativo) cell.malattiaMin = residuo;
        else if (reasons.has('infortunio') && lavorativo) cell.infortunioMin = residuo;
      } else if (d.festivo) cell.tipo = 'festivo';
      else if (d.weekend) cell.tipo = 'weekend';
      // Solo giorni già finiti: oggi chi non ha timbrato può ancora farlo
      else if (hasPresence && d.date < today) cell.tipo = 'giustificare';

      tot.ordinarieMin += Math.min(worked, ORE_GIORNO_MIN);
      tot.straordMin += cell.straord;
      tot.permessoMin += cell.permessoMin;
      tot.maltempoMin += cell.maltempoMin;
      tot.malattiaMin += cell.malattiaMin;
      tot.infortunioMin += cell.infortunioMin;
      if (cell.tipo === 'ferie') tot.ferieGiorni++;
      if (cell.tipo === 'malattia') tot.malattiaGiorni++;
      if (cell.tipo === 'altro') tot.altroGiorni++;
      if (cell.tipo === 'giustificare') tot.daGiustificare++;
      if (cell.anomalia) tot.anomalie++;
      return cell;
    });
    lavoratori.push({ id: w.id, nome: w.nome, cells, tot });
  }
  lavoratori.sort((a, b) => a.nome.localeCompare(b.nome, 'it'));

  // Richieste in attesa: tutte, anche di altri mesi (ferie di ottobre chieste a settembre)
  const { data: pend } = await supabase.from('worker_absences')
    .select('id, worker_id, tipo, date_from, date_to, ora_dalle, ora_alle, note, stato, da_lavoratore, created_at, workers(full_name)')
    .eq('company_id', companyId).eq('stato', 'richiesta').order('date_from');
  const richieste = (pend || []).map(({ workers, ...a }) => ({ ...a, nome: workers?.full_name || '' }));
  const giorniLavorativi = days.filter(d => !d.weekend && !d.festivo).length;

  return { month, from, to, days, giorniLavorativi, lavoratori, richieste, assenze: approved, regole: { oreGiornoMin: ORE_GIORNO_MIN } };
}

module.exports = { buildOreMese, festivita, ORE_GIORNO_MIN };
