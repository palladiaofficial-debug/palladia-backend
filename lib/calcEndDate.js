'use strict';

/**
 * Calcola la data di fine lavori partendo da startDate + contractDays.
 * daysType 'lavorativi' esclude sabato e domenica.
 * suspensionDays è un array di stringhe 'YYYY-MM-DD' che vengono saltate.
 * Restituisce una stringa 'YYYY-MM-DD' oppure null se i parametri sono incompleti.
 */
function calcEndDate(startDate, contractDays, daysType = 'solari', suspensionDays = []) {
  if (!startDate || !contractDays || contractDays <= 0) return null;

  const suspSet = new Set(suspensionDays);
  const toISO = d => d.toISOString().split('T')[0];

  const start = new Date(startDate);
  start.setUTCHours(12, 0, 0, 0); // anchor a mezzogiorno per evitare DST edge-case

  let current = new Date(start);
  let remaining = Number(contractDays);

  while (remaining > 0) {
    current.setUTCDate(current.getUTCDate() + 1);
    const dow = current.getUTCDay(); // 0=Dom, 6=Sab
    const iso = toISO(current);

    if (daysType === 'lavorativi' && (dow === 0 || dow === 6)) continue;
    if (suspSet.has(iso)) continue;
    remaining--;
  }

  return toISO(current);
}

module.exports = { calcEndDate };
