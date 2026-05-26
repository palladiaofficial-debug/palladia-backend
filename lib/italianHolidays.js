'use strict';

/**
 * lib/italianHolidays.js
 * Calcola le festività italiane per un dato anno:
 *   - Festività nazionali fisse
 *   - Pasqua e Lunedì di Pasqua (algoritmo Meeus/Jones/Butcher)
 *   - Santo Patrono per comune (lookup tabella)
 *
 * Usato da calcEndDate per escludere le festività nei giorni lavorativi.
 */

// ─── Algoritmo di Meeus/Jones/Butcher per la Pasqua gregoriana ───────────────
function easterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day   = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

// ─── Festività nazionali fisse (MM-DD) ───────────────────────────────────────
const FIXED_NATIONAL = [
  '01-01', // Capodanno
  '01-06', // Epifania
  '04-25', // Festa della Liberazione
  '05-01', // Festa del Lavoro
  '06-02', // Festa della Repubblica
  '08-15', // Ferragosto (Assunzione della Beata Vergine Maria)
  '11-01', // Ognissanti
  '12-08', // Immacolata Concezione
  '12-25', // Natale
  '12-26', // Santo Stefano
];

// ─── Santo Patrono per comune (chiave: nome lowercase, valore: 'MM-DD') ──────
// Fonte: calendari ufficiali comunali e tradizione cattolica italiana
const PATRON_SAINTS = {
  // A
  'agrigento':          '02-25', // San Gerlando
  'alessandria':        '11-15', // San Baudolino
  'ancona':             '05-04', // San Ciriaco
  'andria':             '09-14', // Esaltazione della Croce (San Riccardo)
  'aosta':              '09-07', // San Grato
  'arezzo':             '08-07', // San Donato
  'ascoli piceno':      '08-05', // Sant\'Emidio
  'asti':               '05-01', // San Secondo

  // B
  'bari':               '12-06', // San Nicola
  'barletta':           '12-30', // San Ruggero
  'belluno':            '11-09', // San Martino (San Floriano)
  'benevento':          '08-24', // San Bartolomeo Apostolo
  'bergamo':            '08-26', // Sant\'Alessandro
  'biella':             '03-21', // San Cassiano
  'bologna':            '10-04', // San Petronio
  'bolzano':            '06-15', // Corpus Domini (San Vigilio – 26/6 a Trento; a Bolzano Maria Immacolata, ma de facto è la Sacra Famiglia. Usiamo tradizione)
  'brescia':            '02-15', // Santi Faustino e Giovita
  'brindisi':           '09-10', // San Lorenzo da Brindisi

  // C
  'cagliari':           '10-30', // San Saturnino
  'caltanissetta':      '07-06', // San Michele Arcangelo
  'campobasso':         '10-23', // San Giorgio (alcune fonti: 23 ott)
  'caserta':            '01-20', // San Sebastiano
  'catania':            '02-05', // Sant\'Agata
  'catanzaro':          '07-16', // Madonna del Carmine
  'chieti':             '08-10', // San Giustino
  'como':               '08-31', // Sant\'Abbondio
  'cosenza':            '02-12', // Sant\'Umile da Bisignano
  'cremona':            '11-13', // Sant\'Omobono
  'crotone':            '05-04', // Madonna di Capocolonna

  // E-F
  'enna':               '07-02', // Madonna della Visitazione
  'ferrara':            '04-23', // San Giorgio
  'firenze':            '06-24', // San Giovanni Battista
  'foggia':             '03-22', // Madonna dei Sette Veli
  'forlì':              '02-04', // San Mercuriale
  'frosinone':          '06-20', // Santi Pietro e Paolo (alcune fonti; comune: San Silverio)

  // G
  'genova':             '06-24', // San Giovanni Battista
  'gorizia':            '09-14', // Sant\'Ilario e Taziano (de facto 14 set)
  'grosseto':           '08-10', // San Lorenzo

  // I-L
  'imperia':            '09-29', // San Maurizio
  'isernia':            '05-26', // San Pietro Celestino
  'la spezia':          '03-19', // San Giuseppe
  "l'aquila":           '06-10', // San Massimo
  'l\'aquila':          '06-10',
  'latina':             '03-19', // San Marco Evangelista (tradizione)
  'lecce':              '08-26', // Sant\'Oronzo
  'lecco':              '08-06', // San Niccolò
  'livorno':            '08-20', // Santa Giulia
  'lodi':               '11-19', // San Bassiano
  'lucca':              '09-13', // Santa Croce (Volto Santo)

  // M
  'macerata':           '08-31', // San Giuliano l\'Ospitaliere
  'mantova':            '03-18', // Sant\'Anselmo
  'massa':              '10-04', // San Francesco
  'matera':             '07-02', // Madonna della Bruna
  'messina':            '06-03', // Madonna della Lettera (processione principale 03/06)
  'milano':             '12-07', // Sant\'Ambrogio
  'modena':             '01-31', // San Geminiano
  'monza':              '06-22', // San Giovanni
  'monza brianza':      '06-22',

  // N
  'napoli':             '09-19', // San Gennaro
  'novara':             '01-22', // San Gaudenzio
  'nuoro':              '08-05', // Sant\'Eusebio

  // O-P
  'oristano':           '02-13', // Sartiglia (tradizione; patrona: Vergine Assunta, 15/08 = nazionale)
  'padova':             '06-13', // Sant\'Antonio di Padova
  'palermo':            '09-04', // Santa Rosalia
  'parma':              '01-13', // Sant\'Ilario
  'pavia':              '10-09', // San Siro
  'perugia':            '01-29', // San Costanzo
  'pesaro':             '09-24', // San Terenzio
  'pesaro urbino':      '09-24',
  'pescara':            '10-10', // San Cetteo
  'piacenza':           '07-04', // Sant\'Antonino
  'pisa':               '06-17', // San Ranieri
  'pistoia':            '07-25', // San Jacopo
  'pordenone':          '11-13', // San Marco
  'potenza':            '05-30', // San Gerardo Maiella

  // R
  'ragusa':             '08-29', // San Giovanni Battista (Ibla)
  'ravenna':            '07-23', // Sant\'Apollinare
  'reggio calabria':    '09-02', // Madonna della Consolazione (1ª dom. settembre, appross. 02/09)
  'reggio emilia':      '11-24', // San Prospero
  'rieti':              '12-04', // Santa Barbara (San Barbato — alcuni: 11/02)
  'rimini':             '10-14', // San Gaudenzo (San Giuliano)
  'roma':               '06-29', // Santi Pietro e Paolo
  'rovigo':             '11-26', // San Bellino

  // S
  'salerno':            '09-21', // San Matteo
  'sassari':            '12-08', // Immacolata (= nazionale; locale: Santi Cosma e Damiano 27/09)
  'savona':             '03-18', // Nostra Signora della Misericordia
  'siena':              '12-01', // Sant\'Ansano (festività di Maria: 16/08 Palio)
  'siracusa':           '12-13', // Santa Lucia
  'sondrio':            '06-19', // Santi Gervasio e Protasio

  // T
  'taranto':            '05-10', // San Cataldo
  'teramo':             '06-19', // San Berardo (Santi Gervasio e Protasio — fonti variabili)
  'terni':              '02-14', // San Valentino
  'torino':             '06-24', // San Giovanni Battista
  'trapani':            '08-16', // Sant\'Alberto di Trapani
  'trento':             '06-26', // San Vigilio
  'treviso':            '04-27', // San Liberale
  'trieste':            '11-03', // San Giusto

  // U-V
  'udine':              '07-12', // Santa Maria del Castello
  'varese':             '05-01', // San Vittore (= nazionale, Festa del Lavoro)
  'venezia':            '04-25', // San Marco (= nazionale, Liberazione)
  'verbania':           '09-08', // Natività della Vergine Maria
  'verbano cusio ossola': '09-08',
  'vercelli':           '08-01', // Sant\'Eusebio di Vercelli
  'verona':             '05-21', // San Zeno
  'vibo valentia':      '03-01', // San Leoluca
  'vicenza':            '04-24', // San Giorgio (vigilia 24, festa 23)
  'viterbo':            '09-04', // Santa Rosa di Viterbo
};

// Cache per anno → Set<'YYYY-MM-DD'>
const _cache = new Map();

/**
 * Restituisce il Set delle date festive nazionali italiane per l'anno dato.
 * Include Pasqua e Lunedì di Pasqua.
 */
function getNationalHolidays(year) {
  const dates = new Set();
  for (const mmdd of FIXED_NATIONAL) {
    dates.add(`${year}-${mmdd}`);
  }
  const easter = easterDate(year);
  const easterISO = easter.toISOString().split('T')[0];
  dates.add(easterISO);
  const easterMonday = new Date(easter);
  easterMonday.setUTCDate(easter.getUTCDate() + 1);
  dates.add(easterMonday.toISOString().split('T')[0]);
  return dates;
}

/**
 * Restituisce 'MM-DD' del Santo Patrono per il comune dato, o null se sconosciuto.
 */
function getPatronSaintMMDD(comune) {
  if (!comune) return null;
  const key = String(comune).toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // rimuove accenti per chiavi base
    .replace(/\s+/g, ' ');
  // Prima prova con accenti (chiave esatta)
  const keyAccented = String(comune).toLowerCase().trim().replace(/\s+/g, ' ');
  return PATRON_SAINTS[keyAccented] || PATRON_SAINTS[key] || null;
}

/**
 * Ritorna true se la data ISO (YYYY-MM-DD) è una festività italiana.
 * Se comune è specificato, include anche il Santo Patrono.
 *
 * Ottimizzato con cache per anno (evita ricalcolo Pasqua ripetuto nel loop).
 */
function isItalianHoliday(dateISO, comune) {
  const year = parseInt(dateISO.slice(0, 4), 10);
  const mmdd = dateISO.slice(5); // 'MM-DD'

  // Festività nazionali fisse — check rapido senza cache
  if (FIXED_NATIONAL.includes(mmdd)) return true;

  // Pasqua e Lunedì di Pasqua — usa cache per anno
  if (!_cache.has(year)) _cache.set(year, getNationalHolidays(year));
  if (_cache.get(year).has(dateISO)) return true;

  // Patrono comunale
  if (comune) {
    const patronMMDD = getPatronSaintMMDD(comune);
    if (patronMMDD && mmdd === patronMMDD) return true;
  }

  return false;
}

module.exports = { isItalianHoliday, getNationalHolidays, getPatronSaintMMDD, easterDate };
