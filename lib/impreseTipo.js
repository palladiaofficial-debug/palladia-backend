'use strict';
/**
 * lib/impreseTipo.js — F-498 / F-501 (AUDIT.md del frontend): che tipo d'impresa è.
 *
 * Il tipo decide cosa le si chiede (documentiStato.requirementsFor). Fonti in lib/visuraLegge.js.
 *  - con_operai: società (i soci che lavorano sono lavoratori, art. 2) o ditta con dipendenti
 *    → visura, DURC, patente, DVR, dichiarazione art. 14 (All. XVII punto 1)
 *  - da_solo: artigiano o lavoratore autonomo senza dipendenti
 *    → visura, DURC, patente, attrezzature, DPI (All. XVII punto 2, art. 21)
 *  - familiare: impresa familiare senza dipendenti → come da_solo: art. 21 (art. 3 c.12,
 *    INL FAQ patente n. 24, interpello 3/2015). F-501: prima le si chiedevano solo visura,
 *    DURC e patente, e mancavano attrezzature e DPI che la legge vuole.
 * Non si sa (null) → come con_operai, cioè come prima.
 *
 * All'impresa non si fanno domande: il tipo lo dice la visura o lo sceglie il titolare.
 */
const TIPI = ['con_operai', 'da_solo', 'familiare'];

/** Il tipo di una riga di subcontractors (tipo_impresa, o il vecchio flag autonomo). */
function tipoDi(row) {
  if (TIPI.includes(row?.tipo_impresa)) return row.tipo_impresa;
  return row?.autonomo ? 'da_solo' : 'con_operai';
}

/** Senza dipendenti: art. 21 (da solo o impresa familiare). */
const senzaDipendenti = (tipo) => tipo === 'da_solo' || tipo === 'familiare';

const SOCIETA = /societ|s\.?\s?r\.?\s?l|s\.?\s?n\.?\s?c|s\.?\s?a\.?\s?s\b|s\.?\s?p\.?\s?a\b|s\.?\s?a\.?\s?p\.?\s?a|cooperativ|consorzi|consortil|g\.?e\.?i\.?e/;
const INDIVIDUALE = /individual|ditta|artigian|piccolo imprenditore|familiare|persona fisica/;
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Dalla visura letta (lib/visuraLegge.campi) al tipo, o null se non si capisce con certezza.
 * Quando non è certo non decide: resta «come con operai» e il titolare può scegliere.
 */
function tipoDaVisura(letto) {
  const f = String(letto?.formaGiuridica || '').toLowerCase();
  if (!f) return null;
  if (SOCIETA.test(f)) return 'con_operai';
  if (!INDIVIDUALE.test(f)) return null;

  const tot = num(letto.addetti), ind = num(letto.indipendenti);
  let dip = num(letto.dipendenti);
  if (dip === null && tot !== null && ind !== null && tot >= ind) dip = tot - ind;
  const familiari = /familiare/.test(f) || letto.familiari === true;

  if (dip !== null) {
    if (dip > 0) return 'con_operai';  // anche un'impresa familiare con dipendenti è datore di lavoro
    // Nella ditta individuale gli indipendenti oltre al titolare sono i familiari collaboratori
    if (familiari || (ind !== null && ind >= 2)) return 'familiare';
    return 'da_solo';
  }
  // Dipendenti non scritti: solo il totale. 0 o 1 (il titolare) = nessun dipendente.
  if (tot !== null && tot <= 1 && !familiari) return 'da_solo';
  return null;
}

module.exports = { TIPI, tipoDi, tipoDaVisura, senzaDipendenti };
