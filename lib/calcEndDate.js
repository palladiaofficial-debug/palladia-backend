'use strict';

const { isItalianHoliday } = require('./italianHolidays');

/**
 * Calcola la data di fine lavori partendo da startDate + contractDays.
 *
 * daysType 'lavorativi': esclude sabato, domenica, festività nazionali italiane
 *   (Pasqua inclusa) e il Santo Patrono del comune del cantiere.
 * daysType 'solari': tutti i giorni solari contati (nessuna esclusione per festività).
 *
 * suspensionDays: array di 'YYYY-MM-DD' saltati sempre (sospensioni meteo/altro).
 * comune: nome del comune (es. 'Genova') — usato per festività locali in modalità lavorativi.
 *
 * Restituisce 'YYYY-MM-DD' oppure null se i parametri sono incompleti.
 */
function calcEndDate(startDate, contractDays, daysType = 'solari', suspensionDays = [], comune = null) {
  if (!startDate || !contractDays || contractDays <= 0) return null;

  const suspSet = new Set(suspensionDays);
  const toISO   = d => d.toISOString().split('T')[0];

  const start = new Date(startDate);
  start.setUTCHours(12, 0, 0, 0); // ancora a mezzogiorno per evitare DST edge-case

  let current   = new Date(start);
  let remaining = Number(contractDays);

  while (remaining > 0) {
    current.setUTCDate(current.getUTCDate() + 1);
    const dow = current.getUTCDay(); // 0=Dom, 6=Sab
    const iso = toISO(current);

    if (daysType === 'lavorativi') {
      if (dow === 0 || dow === 6)         continue; // weekend
      if (isItalianHoliday(iso, comune))  continue; // festività nazionale + patrono
    }
    if (suspSet.has(iso)) continue; // sospensione meteo/altro

    remaining--;
  }

  return toISO(current);
}

module.exports = { calcEndDate };
