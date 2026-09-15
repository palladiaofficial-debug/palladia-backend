'use strict';
/**
 * lib/weatherShift.js
 *
 * F-199 (AUDIT.md): "la fascia oraria possa essere impostata, perché se
 * lavoro di giorno non mi interessa se piove la sera, e se lavoro di notte
 * non mi interessa se piove di giorno". ARPAL fornisce precipitazione
 * cumulata su base oraria in UTC (verificato scaricando un'estrazione
 * reale — l'avviso sul portale stesso lo conferma: "Tutti i dati raccolti
 * sono riferiti al sistema UTC"). Questo modulo converte ogni ora UTC in
 * ora locale Europe/Rome (gestendo il cambio ora legale/solare tramite
 * Intl, non aritmetica manuale) e la assegna al giorno di turno corretto.
 *
 * Un turno che attraversa la mezzanotte (es. notte 20:00-06:00) viene
 * attribuito al giorno in cui INIZIA — le ore dopo mezzanotte contano per
 * il turno iniziato la sera prima, non per il "giorno" col loro stesso
 * numero di calendario. Stessa convenzione già in uso altrove nel prodotto
 * per i turni notturni (vedi selftest_worker_hours_report_late_entry.js).
 */

/**
 * Converte un istante UTC (data+ora ARPAL) nella data/ora locale Europe/Rome.
 * @param {string} dateISO - 'YYYY-MM-DD' (giorno UTC della riga oraria ARPAL)
 * @param {string} hhmm - 'HH:MM' inizio ora UTC (es. '07:00')
 * @returns {{ localDate: string, localHour: number }}
 */
function utcHourToRomeLocal(dateISO, hhmm) {
  const utcDate = new Date(`${dateISO}T${hhmm}:00Z`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(utcDate);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { localDate: `${map.year}-${map.month}-${map.day}`, localHour: Number(map.hour) };
}

function addDaysISO(dateISO, delta) {
  const d = new Date(dateISO + 'T12:00:00Z'); // mezzogiorno UTC: evita ambiguità di ±1 giorno da DST
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().split('T')[0];
}

function hourFromHHMM(hhmm) { return Number(hhmm.split(':')[0]) + Number(hhmm.split(':')[1]) / 60; }

/**
 * Determina a quale "giorno di turno" (log_date) appartiene un'ora locale,
 * dato l'orario di inizio/fine turno configurato per il cantiere. Restituisce
 * null se quell'ora è fuori dal turno (non deve contare per nessun giorno).
 *
 * @param {string} localDate - 'YYYY-MM-DD'
 * @param {number} localHour - 0-23
 * @param {string} shiftStart - 'HH:MM'
 * @param {string} shiftEnd - 'HH:MM'
 * @returns {string|null} log_date a cui attribuire quest'ora
 */
function assignShiftDate(localDate, localHour, shiftStart, shiftEnd) {
  const start = hourFromHHMM(shiftStart);
  const end   = hourFromHHMM(shiftEnd);

  if (start === end) return localDate; // turno "24 ore" — nessun filtro reale, tutto conta

  if (start < end) {
    // Turno diurno, non attraversa la mezzanotte: es. 08:00-18:00.
    return (localHour >= start && localHour < end) ? localDate : null;
  }

  // Turno notturno, attraversa la mezzanotte: es. 20:00-06:00.
  if (localHour >= start) return localDate;                 // sera: 20:00-23:59 di localDate
  if (localHour < end)    return addDaysISO(localDate, -1);  // notte fonda: 00:00-05:59, appartiene al turno iniziato IERI
  return null; // ore di "giorno" per un cantiere che lavora solo di notte
}

/**
 * Somma la precipitazione oraria ARPAL nella sola fascia di turno configurata,
 * e separatamente il totale sulle 24h intere (per trasparenza/audit).
 *
 * @param {Array<{date: string, hour: string, precipitation_mm: number|null, valid: boolean}>} hourlyRows
 *   righe orarie da parseArpalCsv (formato orario) — date='YYYY-MM-DD' (UTC), hour='HH:MM' (inizio ora UTC)
 * @param {string} shiftStart - 'HH:MM'
 * @param {string} shiftEnd - 'HH:MM'
 * @returns {Map<string, {shiftMm: number, fullDayMm: number, hasInvalid: boolean}>} chiave = log_date locale
 */
function sumShiftPrecipitation(hourlyRows, shiftStart, shiftEnd) {
  const byDate = new Map();
  const ensure = (d) => {
    if (!byDate.has(d)) byDate.set(d, { shiftMm: 0, fullDayMm: 0, hasInvalid: false });
    return byDate.get(d);
  };

  for (const row of hourlyRows) {
    const { localDate, localHour } = utcHourToRomeLocal(row.date, row.hour);
    // Il totale "giornata intera" segue il giorno locale della singola ora,
    // non il giorno di turno — resta un dato di audit indipendente dal turno.
    const fullDayBucket = ensure(localDate);
    if (!row.valid || row.precipitation_mm === null) { fullDayBucket.hasInvalid = true; continue; }
    fullDayBucket.fullDayMm += row.precipitation_mm;

    const shiftDate = assignShiftDate(localDate, localHour, shiftStart, shiftEnd);
    if (shiftDate !== null) {
      const shiftBucket = ensure(shiftDate);
      shiftBucket.shiftMm += row.precipitation_mm;
    }
  }

  for (const bucket of byDate.values()) {
    bucket.shiftMm = Math.round(bucket.shiftMm * 100) / 100;
    bucket.fullDayMm = Math.round(bucket.fullDayMm * 100) / 100;
  }

  return byDate;
}

module.exports = { utcHourToRomeLocal, assignShiftDate, sumShiftPrecipitation };
