'use strict';
// ── Presenze e Squadra del cantiere (F-326, pezzo 2 di F-321, AUDIT.md del frontend) ──
// settimana(): la griglia operaio × giorno con entrata e uscita, dallo stesso
//   calcolo del foglio ore (services/workerHoursReport: pausa pranzo, ritardi,
//   motivi d'uscita). Qui si LEGGE soltanto: niente scritture su presence_logs.
// squadra(): chi lavora davvero qui (timbrature degli ultimi 30 giorni) con lo
//   stato dei documenti, e chi è assegnato ma non viene ("Togli").
const supabase = require('./supabase');
const { complianceStatus } = require('./compliance');
const { buildWorkerHoursReport } = require('../services/workerHoursReport');
const { inAPezzi } = require('./inAPezzi');

const GIORNI_QUI = 30;
const GIORNI_URGENTE = 7; // come il Riepilogo (F-324)
const romeDay = (iso) => new Date(iso).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
function addDays(day, n) { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const dayStartIso = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 2 * 3600e3).toISOString();

/** Lunedì della settimana che contiene `day` (YYYY-MM-DD). */
function lunedi(day) {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/** Nota corta per la cella: il motivo d'uscita o l'uscita mancante, non il testo lungo del foglio. */
function notaBreve(anomaly) {
  if (!anomaly) return null;
  const primo = String(anomaly).split(';')[0].split(':')[0].trim();
  return primo.length > 28 ? `${primo.slice(0, 27)}…` : primo;
}

/**
 * @returns {{ da, a, giorni: string[], persone: { workerId, nome, totaleMin, giorni: Record<string, { entrata, uscita, minuti, nota, mancaUscita }> }[] }}
 */
async function settimana(companyId, siteId, da) {
  const from = lunedi(da);
  const to = addDays(from, 6);
  const report = await buildWorkerHoursReport(siteId, companyId, from, to, null, true);
  const persone = (report.workers || []).map(w => {
    const giorni = {};
    for (const d of w.days || []) {
      const e = d.entries || [];
      const entrate = e.map(x => x.entry_time).filter(Boolean);
      const ultima = e[e.length - 1];
      giorni[d.date_key] = {
        entrata: entrate[0] || null,
        uscita: ultima?.exit_time || null,
        minuti: d.day_total_minutes || 0,
        nota: notaBreve(e.map(x => x.anomaly).find(Boolean)),
        mancaUscita: e.some(x => x.entry_time && !x.exit_time), // oggi = ancora dentro
      };
    }
    return { workerId: w.id, nome: w.full_name, totaleMin: w.total_minutes || 0, giorni };
  }).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  // Lunedì–venerdì sempre; sabato e domenica solo se qualcuno ha lavorato
  const giorni = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    if (i < 5 || persone.some(p => p.giorni[d])) giorni.push(d);
  }
  return { da: from, a: to, giorni, persone };
}

function documento(data, ultimoGiorno, today) {
  const st = complianceStatus(data);
  const scaduto = st === 'expired' || st === 'not_set';
  return { stato: st === 'expired' ? 'scaduta' : st === 'not_set' ? 'mancante' : st === 'expiring' ? 'in_scadenza' : 'ok', scadenza: data || null,
    urgente: scaduto && !!ultimoGiorno && ultimoGiorno >= addDays(today, -GIORNI_URGENTE) };
}

/**
 * @returns {{ lavorano: object[], nonVengono: object[] }}
 */
async function squadra(companyId, siteId, { today = romeDay(new Date().toISOString()) } = {}) {
  const since = addDays(today, -GIORNI_QUI);
  const [logsRes, assRes] = await Promise.all([
    supabase.from('presence_logs').select('worker_id, timestamp_server')
      .eq('company_id', companyId).eq('site_id', siteId).gte('timestamp_server', dayStartIso(since))
      .order('timestamp_server', { ascending: false }).limit(10000),
    supabase.from('worksite_workers').select('worker_id').eq('company_id', companyId).eq('site_id', siteId).eq('status', 'active'),
  ]);
  if (logsRes.error) throw new Error(logsRes.error.message);
  if (assRes.error) throw new Error(assRes.error.message);
  const ultimoQui = new Map();
  for (const l of logsRes.data || []) {
    const d = romeDay(l.timestamp_server);
    if (d >= since && (!ultimoQui.has(l.worker_id) || ultimoQui.get(l.worker_id) < d)) ultimoQui.set(l.worker_id, d);
  }
  const assegnati = new Set((assRes.data || []).map(a => a.worker_id));
  const ids = [...new Set([...ultimoQui.keys(), ...assegnati])];
  const ws = await inAPezzi(ids, (b) => supabase.from('workers')
    .select('id, full_name, is_active, safety_training_expiry, health_fitness_expiry').eq('company_id', companyId).in('id', b));
  const attivi = ws.filter(w => w.is_active !== false);

  const lavorano = attivi.filter(w => ultimoQui.has(w.id)).map(w => ({
    workerId: w.id, nome: w.full_name, ultimoGiorno: ultimoQui.get(w.id), assegnato: assegnati.has(w.id),
    formazione: documento(w.safety_training_expiry, ultimoQui.get(w.id), today),
    idoneita: documento(w.health_fitness_expiry, ultimoQui.get(w.id), today),
  })).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));

  // Assegnati che qui non timbrano: lavorano altrove o non timbrano proprio
  const assenti = attivi.filter(w => assegnati.has(w.id) && !ultimoQui.has(w.id));
  const altrove = new Set();
  if (assenti.length) {
    const r = await inAPezzi(assenti.map(w => w.id), (b) => supabase.from('presence_logs').select('worker_id')
      .eq('company_id', companyId).in('worker_id', b).gte('timestamp_server', dayStartIso(since)).limit(5000));
    for (const x of r) altrove.add(x.worker_id);
  }
  const nonVengono = assenti.map(w => ({ workerId: w.id, nome: w.full_name, dove: altrove.has(w.id) ? 'altrove' : 'mai' }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
  return { lavorano, nonVengono };
}

module.exports = { settimana, squadra, lunedi, notaBreve };
