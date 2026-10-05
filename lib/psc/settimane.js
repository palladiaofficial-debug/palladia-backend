'use strict';
/**
 * lib/psc/settimane.js — F-298 (AUDIT.md del frontend). Il cronoprogramma a
 * settimane: i coordinatori spesso non possono prevedere le date esatte e
 * pianificano "settimana 3–5". In questa scala ogni lavorazione inizia di
 * lunedì e finisce di venerdì; la settimana 1 è quella dell'inizio lavori.
 * Le date restano nel DB (servono a interferenze e PDF), arrotondate alla
 * settimana. Funzioni pure.
 */
const DAY = 86400000;
const ms = (iso) => Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`);
const iso = (m) => new Date(m).toISOString().slice(0, 10);

/** Il lunedì della settimana di una data. */
function lunedi(d) {
  const m = ms(d);
  const wd = (new Date(m).getUTCDay() + 6) % 7; // 0 = lunedì
  return iso(m - wd * DAY);
}
const venerdi = (d) => iso(ms(lunedi(d)) + 4 * DAY);

/** Numero della settimana (1 = la settimana dell'inizio lavori). */
function numero(d, inizio) {
  if (!d || !inizio) return null;
  return Math.floor((ms(lunedi(d)) - ms(lunedi(inizio))) / (7 * DAY)) + 1;
}
/** Il lunedì della settimana N. */
const lunediDi = (n, inizio) => iso(ms(lunedi(inizio)) + (n - 1) * 7 * DAY);
const venerdiDi = (n, inizio) => iso(ms(lunedi(inizio)) + (n - 1) * 7 * DAY + 4 * DAY);

/** Arrotonda una lavorazione alle settimane intere (lunedì–venerdì). */
function arrotonda(l) {
  if (!l.start_date || !l.end_date) return l;
  const s = lunedi(l.start_date);
  let e = venerdi(l.end_date);
  if (e < s) e = venerdi(s);
  return { ...l, start_date: s, end_date: e };
}

/** Durata in settimane (intere) di una lavorazione. */
function durata(l) {
  if (!l.start_date || !l.end_date) return null;
  return Math.max(1, Math.round((ms(lunedi(l.end_date)) - ms(lunedi(l.start_date))) / (7 * DAY)) + 1);
}

/** "settimana 3" / "settimane 3–5" */
function etichetta(l, inizio) {
  const a = numero(l.start_date, inizio), b = numero(l.end_date, inizio);
  if (a == null) return '';
  return a === b ? `settimana ${a}` : `settimane ${a}–${b}`;
}

module.exports = { lunedi, venerdi, numero, lunediDi, venerdiDi, arrotonda, durata, etichetta };
