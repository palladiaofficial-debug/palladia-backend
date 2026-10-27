'use strict';
// ── Sospeso o non lavora più qui (F-396, AUDIT.md del frontend) ─────────────
// Il titolare (27/10): «serve la possibilità di poter mettere in sospensione o
// poter licenziare un operaio. Così non esce sempre come timbratura assente o
// come formazione scaduta ecc».
//  - Sospeso: un'assenza approvata di tipo 'sospensione' (F-386) che copre
//    oggi. Chi non ha timbrato la mette già a parte (lib/presenceMissing.js);
//    qui servono gli avvisi sulle scadenze, che tacciono finché dura.
//  - Non lavora più qui: is_active=false con il giorno e il motivo
//    (migrations/259). Tutti gli avvisi leggono già solo gli attivi.
const supabase = require('./supabase');

// Non da lib/daFare: daFare → documentiStato → qui sarebbe un giro di require
const romeDate = () => new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });

const MOTIVI = ['licenziamento', 'dimissioni', 'fine_contratto', 'altro'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const WORKER_COLS = 'id, full_name, is_active, cessato_il, cessazione_motivo';

const errore = (status, message) => Object.assign(new Error(message), { status });

/**
 * Sospensioni in corso o in arrivo per lavoratore: Map workerId → { id, dal, al, inCorso }.
 * Per ogni lavoratore la più vicina (quella in corso, se c'è).
 */
async function sospensioni(companyId, { today = romeDate(), workerIds } = {}) {
  let q = supabase.from('worker_absences').select('id, worker_id, date_from, date_to')
    .eq('company_id', companyId).eq('tipo', 'sospensione').eq('stato', 'approvata')
    .gte('date_to', today).order('date_from', { ascending: true });
  if (workerIds) {
    if (!workerIds.length) return new Map();
    q = q.in('worker_id', workerIds);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const out = new Map();
  for (const a of data || []) {
    if (!out.has(a.worker_id)) out.set(a.worker_id, { id: a.id, dal: a.date_from, al: a.date_to, inCorso: a.date_from <= today });
  }
  return out;
}

/**
 * La sospensione in corso o in arrivo ({ id, dal, al } o null) su ogni
 * lavoratore, per la scheda e l'elenco. Per un elenco lungo si leggono quelle
 * di tutta l'azienda (poche): un .in() con centinaia di id supera la lunghezza
 * dell'URL e fallisce (come F-321; 679 lavoratori nell'azienda E2E).
 */
async function conSospensione(companyId, workers) {
  const sosp = await sospensioni(companyId, workers.length > 50 ? {} : { workerIds: workers.map(w => w.id) });
  return workers.map(w => {
    const s = sosp.get(w.id);
    return { ...w, sospensione: s ? { id: s.id, dal: s.dal, al: s.al } : null };
  });
}

/** Il lavoratore non lavora più qui da `ultimoGiorno` (oggi o prima). */
async function cessa({ companyId, workerId, ultimoGiorno, motivo, today = romeDate() }) {
  if (!isDate(ultimoGiorno)) throw errore(400, 'ultimo_giorno obbligatorio (YYYY-MM-DD)');
  // Fino all'ultimo giorno deve poter timbrare: nel futuro si segna quel giorno
  if (ultimoGiorno > today) throw errore(400, "l'ultimo giorno non può essere nel futuro: segnalo quel giorno");
  if (!MOTIVI.includes(motivo)) throw errore(400, `motivo deve essere uno tra: ${MOTIVI.join(', ')}`);
  const { data, error } = await supabase.from('workers')
    .update({ is_active: false, cessato_il: ultimoGiorno, cessazione_motivo: motivo })
    .eq('id', workerId).eq('company_id', companyId).select(WORKER_COLS).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw errore(404, 'WORKER_NOT_FOUND');
  return data;
}

/** Torna a lavorare qui (errore, o riassunto). */
async function riattiva({ companyId, workerId }) {
  const { data, error } = await supabase.from('workers')
    .update({ is_active: true, cessato_il: null, cessazione_motivo: null })
    .eq('id', workerId).eq('company_id', companyId).select(WORKER_COLS).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw errore(404, 'WORKER_NOT_FOUND');
  return data;
}

module.exports = { MOTIVI, sospensioni, conSospensione, cessa, riattiva };
