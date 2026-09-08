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
      if (next && next.event_type === 'EXIT') {
        bucket(dateKeyRome(log.timestamp_server)).pairs.push({ entry: log, exit: next });
        i += 2;
      } else {
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
  const minutes    = site?.lunch_break_minutes         ?? company?.lunch_break_minutes         ?? 30;
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

module.exports = {
  dateKeyRome, pairLogsByDay, flattenDayLogs, shiftDateStr,
  resolveLunchBreakConfig, applyLunchBreak,
};
