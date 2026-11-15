'use strict';
/**
 * lib/visuraLegge.js — F-501 (AUDIT.md del frontend): cosa ci dice la visura camerale,
 * per capire che impresa è e cosa le si deve chiedere per legge.
 *
 * Usato da tutte le strade da cui arriva una visura: il link dell'impresa e la scheda
 * del titolare (impreseControllo), «Carica documenti delle imprese» (impreseCarica/lettura),
 * «+ Aggiungi impresa» dalla foto (imprese.leggiPerAggiungere).
 *
 * Fonti (verificate il 15/11/2026):
 *  - Allegato XVII D.Lgs. 81/2008: punto 1 imprese (CCIAA con oggetto sociale inerente,
 *    DVR, DURC, dichiarazione art. 14); punto 2 lavoratori autonomi (CCIAA, attrezzature,
 *    DPI, attestati ove previsti, DURC); punto 3 il subappalto con gli stessi criteri.
 *  - Art. 2 c.1 lett. a): il socio lavoratore di società è «lavoratore» → una società ha il DVR.
 *  - Art. 3 c.12 e art. 21; INL FAQ patente n. 24; interpello 3/2015: all'impresa familiare
 *    (art. 230-bis c.c.) senza dipendenti si applica l'art. 21, come all'autonomo.
 *  - Addetti in visura = indipendenti (titolare, soci, familiari collaboratori) + dipendenti.
 */

// Le righe che si aggiungono al JSON chiesto al modello (stesse chiavi in tutti i prompt)
const CAMPI_PROMPT = `  "forma_giuridica": "solo per la visura: la forma giuridica come è scritta (es. società a responsabilità limitata semplificata, impresa individuale), o null",
  "addetti": "solo per la visura: il numero TOTALE di addetti scritto nella visura (numero), o null",
  "addetti_dipendenti": "solo per la visura: quanti addetti DIPENDENTI sono scritti (numero; 0 se è scritto 0), o null se non c'è la riga dei dipendenti",
  "addetti_indipendenti": "solo per la visura: quanti addetti INDIPENDENTI (titolare, soci, familiari) sono scritti (numero), o null",
  "familiari": "solo per la visura: true se nomina collaboratori familiari, familiari coadiuvanti o impresa familiare; false se non ne nomina; null se non è una visura",
  "stato_attivita": "solo per la visura: lo stato dell'impresa come è scritto (es. attiva, inattiva, sospesa, cessata, in liquidazione, scioglimento, liquidazione giudiziale, fallimento), o null",
  "ateco": "solo per la visura: i codici ATECO dell'attività svolta, es. ["43.21.01"], o []",
  "attivita_edile": "solo per la visura: true se l'attività svolta è un lavoro che si fa in cantiere (costruzioni, demolizioni, scavi, impianti, finiture, serramenti con posa, ponteggi, bonifiche, coperture, noleggio di macchine con operatore…), false se chiaramente no (es. solo commercio o servizi d'ufficio), null se non si capisce"`;

const REGOLA_PROMPT = `- Visura: gli addetti sono nella sezione «Addetti» (indipendenti + dipendenti); lo stato è vicino a «Stato attività» o nella sezione delle procedure; l'attività in «Attività» o «Codice ATECO».`;

const testo = (v) => {
  if (v === null || v === undefined) return null;
  const t = Array.isArray(v) ? v.join(' ') : String(v);
  const s = t.replace(/\s+/g, ' ').trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
};
const numero = (v) => {
  const t = testo(v);
  if (t === null) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
const bool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

/** «Stato attività» in una parola. Ordine importante: «inattiva» contiene «attiva». */
function statoDi(s) {
  const t = String(s || '').toLowerCase();
  if (!t) return null;
  if (/fallim|liquidazione giudiziale|liquidazione coatta|amministrazione straordinaria/.test(t)) return 'procedura';
  if (/cessat|cancellat/.test(t)) return 'cessata';
  if (/liquidazion|scioglim|sciolt/.test(t)) return 'liquidazione';
  if (/inattiv/.test(t)) return 'inattiva';
  if (/sospes/.test(t)) return 'sospesa';
  if (/attiv/.test(t)) return 'attiva';
  return null;  // concordato, ecc.: non decido io
}

function atecoDi(v) {
  const lista = Array.isArray(v) ? v : (testo(v) ? [testo(v)] : []);
  const out = [];
  for (const x of lista) for (const m of String(x).matchAll(/\b\d{2}(?:\.\d{1,2}){0,2}\b/g)) if (!out.includes(m[0])) out.push(m[0]);
  return out.slice(0, 12);
}

/** Dalla risposta del modello ai campi della visura. */
function campi(r) {
  return {
    formaGiuridica: testo(r?.forma_giuridica),
    addetti: numero(r?.addetti),
    dipendenti: numero(r?.addetti_dipendenti),
    indipendenti: numero(r?.addetti_indipendenti),
    familiari: bool(r?.familiari),
    statoAttivita: testo(r?.stato_attivita),
    ateco: atecoDi(r?.ateco),
    attivitaEdile: bool(r?.attivita_edile),
  };
}

// Codici ATECO di chi lavora in cantiere. Sezione F (41, 42, 43) e i mestieri che posano o
// lavorano in cantiere pur stando altrove (strutture metalliche, serramenti, installazione
// macchine, bonifiche e rifiuti, noleggio macchine, pulizie e verde, ingegneria).
const ATECO_CANTIERE = /^(41|42|43|16\.2|23\.[67]|25\.[129]|28\.22|33\.[12]|35|36|37|38|39|49\.4|71\.1|77\.3|81\.[23])/;

/**
 * Il giudizio sulla visura oltre alla data: { codice, valore } se non va, altrimenti null.
 *  - impresa cessata, inattiva, sospesa, in liquidazione o in procedura concorsuale: non può
 *    prendere lavori (All. XVII punto 1 a: iscrizione CCIAA valida);
 *  - attività che non c'entra coi cantieri (All. XVII punto 1 a: «oggetto sociale inerente»):
 *    solo se lo dicono insieme i codici ATECO E il modello, per non scartare visure buone.
 */
function giudizioVisura(letto) {
  const stato = statoDi(letto?.statoAttivita);
  if (stato && stato !== 'attiva') return { codice: 'impresa_non_attiva', valore: stato };
  const ateco = letto?.ateco || [];
  if (letto?.attivitaEdile === false && ateco.length && !ateco.some(c => ATECO_CANTIERE.test(c))) {
    return { codice: 'attivita_non_inerente', valore: ateco.join(', ') };
  }
  return null;
}

const STATO_ITALIANO = { procedura: 'in fallimento o liquidazione giudiziale', cessata: 'cessata', liquidazione: 'in liquidazione', inattiva: 'inattiva (non ha ancora iniziato l\'attività)', sospesa: 'con l\'attività sospesa' };

module.exports = { CAMPI_PROMPT, REGOLA_PROMPT, campi, statoDi, atecoDi, giudizioVisura, ATECO_CANTIERE, STATO_ITALIANO };
