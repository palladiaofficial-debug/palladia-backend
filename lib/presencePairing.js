'use strict';
/**
 * lib/presencePairing.js
 *
 * Unico algoritmo di pairing ENTRY/EXIT per tutta la piattaforma (PDF Registro
 * Presenze, PDF/XLSX Ore Lavorate, CSV export, cedolini Studio CDL).
 *
 * Prima di questo modulo esistevano 7 copie indipendenti dello stesso pairing
 * (presenceReport.js, workerHoursReport.js, studio.js ore-mensili, reports.js
 * ×3, siteExport.js), tutte con lo stesso bug strutturale: raggruppavano i log
 * per giorno solare (Europe/Rome) PRIMA di accoppiare ENTRY/EXIT. Un turno che
 * attraversa la mezzanotte (es. 22:00 → 06:00) veniva quindi sempre spezzato in
 * due anomalie — "Uscita mancante" a fine primo giorno, "Uscita senza entrata"
 * a inizio secondo giorno — invece di essere riconosciuto come un unico turno.
 *
 * Fix: accoppiare PRIMA, sull'intero stream cronologico del lavoratore (che può
 * coprire più giorni), poi assegnare ogni coppia/anomalia al giorno Rome
 * dell'evento che la determina (ENTRY per le coppie e gli ENTRY orfani, EXIT
 * per gli EXIT orfani). Un turno notturno risulta così un'unica riga sul giorno
 * di inizio, con l'orario di uscita del giorno successivo incluso.
 */

// ISO timestamp → "YYYY-MM-DD" (Europe/Rome). Usa locale sv-SE che produce
// ISO date nativo senza toISOString() (sempre UTC, sbagliato dopo le 22/23
// in estate/inverno a Roma).
function dateKeyRome(ts) {
  return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
}

/**
 * Accoppia sequenzialmente ENTRY→EXIT sull'intero stream di log di UN
 * lavoratore (già ordinato per timestamp_server asc, può coprire più giorni),
 * poi raggruppa il risultato per giorno Rome.
 *
 *   ENTRY seguito da EXIT       → coppia valida, assegnata al giorno dell'ENTRY
 *   ENTRY non seguito da EXIT   → "ENTRY orfano", assegnato al proprio giorno
 *   EXIT senza ENTRY precedente → "EXIT orfano", assegnato al proprio giorno
 *
 * @param {Array} logs  Log di un singolo worker, sorted by timestamp_server asc
 * @returns {Map<string, {
 *   pairs:         Array<{entry: object, exit: object}>,
 *   orphanEntries: Array<object>,
 *   orphanExits:   Array<object>
 * }>}  Mappa dateKey (YYYY-MM-DD, Europe/Rome) → contenuto del giorno
 */
// Stesso limite di punch_atomic (migrations/161_punch_atomic_stale_entry_guard.sql,
// F-043 AUDIT.md — "osservato: 6 giorni, Giuseppe Di Leonardo, MSCedilizia"):
// quella guardia impedisce che un ENTRY più vecchio di 16h venga abbinato come
// EXIT del tocco corrente AL MOMENTO DELLA TIMBRATURA — ma non protegge questa
// funzione, che accoppia sequenzialmente qualunque ENTRY/EXIT già presente in
// tabella. Dati precedenti alla guardia (o una correzione manuale con la data
// sbagliata) restano in presence_logs e finivano accoppiati in un "turno" di
// giorni, sommato senza alcun controllo nelle ore lavorate/straordinari di
// tutti i report — F-153 (AUDIT.md, frontend). Stesso limite qui: un dato che
// punch_atomic non lascerebbe mai accoppiare in tempo reale non va accoppiato
// retroattivamente in un report.
const MAX_PLAUSIBLE_PAIR_MS = 16 * 60 * 60 * 1000;

function pairLogsByDay(logs) {
  const byDay = new Map();
  const bucket = (dateKey) => {
    if (!byDay.has(dateKey)) byDay.set(dateKey, { pairs: [], orphanEntries: [], orphanExits: [] });
    return byDay.get(dateKey);
  };

  let i = 0;
  while (i < logs.length) {
    const log = logs[i];
    if (log.event_type === 'ENTRY') {
      const next = i + 1 < logs.length ? logs[i + 1] : null;
      const durationMs = next ? new Date(next.timestamp_server) - new Date(log.timestamp_server) : null;
      if (next && next.event_type === 'EXIT' && durationMs <= MAX_PLAUSIBLE_PAIR_MS) {
        bucket(dateKeyRome(log.timestamp_server)).pairs.push({ entry: log, exit: next });
        i += 2;
      } else {
        // Turno implausibile (>16h) o EXIT assente: l'ENTRY diventa orfana sul
        // proprio giorno; l'eventuale EXIT lontano viene lasciata al giro
        // successivo del loop, dove sarà bucketizzata come orfana sul SUO
        // giorno (branch 'else' sotto) — mai sommata come se fosse un turno
        // reale insieme a questa ENTRY.
        bucket(dateKeyRome(log.timestamp_server)).orphanEntries.push(log);
        i += 1;
      }
    } else {
      bucket(dateKeyRome(log.timestamp_server)).orphanExits.push(log);
      i += 1;
    }
  }
  return byDay;
}

// Tutti i log grezzi di un giorno (coppie + orfani), utile per medie GPS e
// metodi — stesso identico set di log che sarebbe finito nel vecchio
// raggruppamento "per giorno prima del pairing".
function flattenDayLogs(dayBucket) {
  const out = [];
  for (const p of dayBucket.pairs) { out.push(p.entry, p.exit); }
  out.push(...dayBucket.orphanEntries, ...dayBucket.orphanExits);
  return out;
}

// YYYY-MM-DD → nuova stringa YYYY-MM-DD spostata di N giorni (± N).
// Usata per allargare la finestra di query di 1 giorno su ciascun lato,
// così un turno a cavallo del bordo from/to (non solo della mezzanotte
// "interna" al periodo) può comunque essere accoppiato correttamente.
function shiftDateStr(yyyymmdd, days) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// ── Pausa pranzo automatica (F-152, AUDIT.md) ─────────────────────────────────
// migrations/195: minuti/soglia configurabili per azienda, con override per
// cantiere (NULL sul cantiere = eredita il valore azienda).

/**
 * Risolve la configurazione effettiva di pausa pranzo per un cantiere:
 * override del cantiere se impostato, altrimenti default dell'azienda.
 * @param {{lunch_break_minutes?:number, lunch_break_threshold_hours?:number}} company
 * @param {{lunch_break_minutes?:number|null, lunch_break_threshold_hours?:number|null}} [site]
 * @returns {{minutes:number, thresholdMinutes:number}}
 */
function resolveLunchBreakConfig(company, site) {
  const minutes    = site?.lunch_break_minutes         ?? company?.lunch_break_minutes         ?? 60;
  const thresholdH = site?.lunch_break_threshold_hours ?? company?.lunch_break_threshold_hours ?? 6;
  return {
    minutes:          Math.max(0, Number(minutes)   || 0),
    thresholdMinutes: Math.max(0, Number(thresholdH) || 0) * 60,
  };
}

function rawPairMinutes(pair) {
  return Math.max(0, Math.round(
    (new Date(pair.exit.timestamp_server) - new Date(pair.entry.timestamp_server)) / 60000
  ));
}

/**
 * Applica la detrazione pausa pranzo alle coppie ENTRY/EXIT di UN giorno.
 *
 * Si applica SOLO quando il giorno ha un'unica coppia continua sopra soglia:
 * se ci sono 2+ coppie, il lavoratore ha già timbrato un'uscita/rientro per la
 * pausa — è già esclusa naturalmente dalla somma delle coppie (il gap tra le
 * coppie non viene mai sommato) — e detrarla di nuovo qui la conteggerebbe
 * due volte.
 *
 * @param {Array<{entry:object, exit:object}>} pairs  Coppie di UN giorno (da pairLogsByDay)
 * @param {{minutes:number, thresholdMinutes:number}} lunchConfig  Da resolveLunchBreakConfig()
 * @returns {Array<{entry:object, exit:object, minutes:number, lunchBreakMinutes:number}>}
 *   Stesso ordine di `pairs`, con `minutes` già al netto della detrazione.
 */
function applyLunchBreak(pairs, lunchConfig) {
  if (!lunchConfig || lunchConfig.minutes <= 0 || pairs.length !== 1) {
    return pairs.map(p => ({ ...p, minutes: rawPairMinutes(p), lunchBreakMinutes: 0 }));
  }
  const raw = rawPairMinutes(pairs[0]);
  if (raw <= lunchConfig.thresholdMinutes) {
    return [{ ...pairs[0], minutes: raw, lunchBreakMinutes: 0 }];
  }
  const deducted = Math.min(lunchConfig.minutes, raw);
  return [{ ...pairs[0], minutes: raw - deducted, lunchBreakMinutes: deducted }];
}

// ── Detrazione ritardo ingresso (migrations/199) ──────────────────────────────
// Richiesto dall'utente il 2026-09-10: un ingresso oltre soglia rispetto
// all'orario di inizio turno previsto comporta una detrazione forfettaria,
// sempre annotata (mai silenziosa). A differenza della pausa pranzo, questa
// regola è SPENTA finché shift_start_time non è configurato esplicitamente
// (company.shift_start_time === null → nessuna detrazione, mai).

/**
 * Risolve soglia/detrazione/orario di inizio turno per un cantiere: override
 * del cantiere se impostato, altrimenti default dell'azienda.
 * @param {{shift_start_time?:string|null, late_entry_threshold_minutes?:number, late_entry_deduction_minutes?:number}} company
 * @param {{shift_start_time?:string|null, late_entry_threshold_minutes?:number|null, late_entry_deduction_minutes?:number|null}} [site]
 * @returns {{shiftStart:string|null, thresholdMinutes:number, deductionMinutes:number}}
 */
function resolveLateEntryConfig(company, site) {
  const shiftStart    = site?.shift_start_time             ?? company?.shift_start_time             ?? null;
  const thresholdMin  = site?.late_entry_threshold_minutes ?? company?.late_entry_threshold_minutes ?? 5;
  const deductionMin  = site?.late_entry_deduction_minutes ?? company?.late_entry_deduction_minutes ?? 30;
  return {
    // shift_start_time da Postgres arriva come "HH:MM:SS" — normalizzato a "HH:MM".
    shiftStart:       shiftStart ? String(shiftStart).slice(0, 5) : null,
    thresholdMinutes: Math.max(0, Number(thresholdMin) || 0),
    deductionMinutes: Math.max(0, Number(deductionMin) || 0),
  };
}

// Minuti dalla mezzanotte (fuso Europe/Rome) di un timestamp — confronto
// diretto su interi, niente costruzione di Date "attese" che dipenderebbe
// dal fuso del server (stesso principio di dateKeyRome sopra).
function minutesOfDayRome(ts) {
  const s = new Date(ts).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Rome', hour12: false }); // "HH:MM:SS"
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Applica la detrazione ritardo alle coppie ENTRY/EXIT (già nette pausa
 * pranzo) di UN giorno — si basa sulla PRIMA entrata del giorno rispetto a
 * shiftStart + soglia; se oltre, detrae deductionMinutes dalla prima coppia
 * (clampata a 0). Nessun effetto se lateConfig.shiftStart è null (regola
 * disattivata) o il giorno non ha coppie complete.
 *
 * @param {Array<{entry:object, exit:object, minutes:number}>} pairsWithMinutes  Coppie di UN giorno, in ordine cronologico
 * @param {{shiftStart:string|null, thresholdMinutes:number, deductionMinutes:number}} lateConfig  Da resolveLateEntryConfig()
 * @returns {Array<{entry:object, exit:object, minutes:number, lateDeductionMinutes:number, lateMinutes:number}>}
 */
function applyLateEntryDeduction(pairsWithMinutes, lateConfig) {
  if (!lateConfig?.shiftStart || pairsWithMinutes.length === 0) {
    return pairsWithMinutes.map(p => ({ ...p, lateDeductionMinutes: 0, lateMinutes: 0 }));
  }
  const [h, m]  = lateConfig.shiftStart.split(':').map(Number);
  const expectedMin = h * 60 + m;
  const first   = pairsWithMinutes[0];
  const actualMin = minutesOfDayRome(first.entry.timestamp_server);
  const lateMinutes = actualMin - expectedMin;

  if (lateMinutes <= lateConfig.thresholdMinutes) {
    return pairsWithMinutes.map(p => ({ ...p, lateDeductionMinutes: 0, lateMinutes: Math.max(0, lateMinutes) }));
  }
  const deducted = Math.min(lateConfig.deductionMinutes, first.minutes);
  return pairsWithMinutes.map((p, i) => i === 0
    ? { ...p, minutes: p.minutes - deducted, lateDeductionMinutes: deducted, lateMinutes }
    : { ...p, lateDeductionMinutes: 0, lateMinutes: 0 });
}

module.exports = {
  dateKeyRome, pairLogsByDay, flattenDayLogs, shiftDateStr,
  resolveLunchBreakConfig, applyLunchBreak,
  resolveLateEntryConfig, applyLateEntryDeduction,
};
