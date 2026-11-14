'use strict';
/**
 * lib/impreseTipo.js — F-498 (AUDIT.md del frontend): che tipo d'impresa è.
 *
 * Il tipo decide cosa le si chiede (documentiStato.requirementsFor), secondo la
 * tabella «Cosa chiediamo a chi» (disegno approvato il 14/11):
 *  - con_operai: società o ditta con dipendenti o soci che lavorano
 *    → visura, DURC, patente, DVR, dichiarazione art. 14 (All. XVII punto 1)
 *  - da_solo: artigiano o lavoratore autonomo senza operai
 *    → visura, DURC, patente, attrezzature, DPI (All. XVII punto 2, art. 21)
 *  - familiare: impresa familiare senza dipendenti → visura, DURC, patente.
 *    Attrezzature e DPI sono «?» nella tabella: spenti finché il consulente non dice sì.
 * Non si sa (null) → come con_operai, cioè come prima.
 *
 * All'impresa non si fanno domande: il tipo lo dice la visura (letta da
 * impreseControllo) o lo sceglie il titolare.
 */
const TIPI = ['con_operai', 'da_solo', 'familiare'];

/** Il tipo di una riga di subcontractors (tipo_impresa, o il vecchio flag autonomo). */
function tipoDi(row) {
  if (TIPI.includes(row?.tipo_impresa)) return row.tipo_impresa;
  return row?.autonomo ? 'da_solo' : 'con_operai';
}

/**
 * Dalla visura letta: { formaGiuridica, addetti } → tipo, o null se non si capisce.
 * Una società ha sempre chi lavora (dipendenti o soci): con_operai.
 * Una ditta individuale: da_solo solo se gli addetti sono scritti e sono 0 (o 1, il titolare).
 */
function tipoDaVisura(letto) {
  const f = String(letto?.formaGiuridica || '').toLowerCase();
  const n = Number.isFinite(letto?.addetti) ? letto.addetti : null;
  if (!f) return null;
  if (/familiare/.test(f)) return 'familiare';
  if (/societ|s\.?r\.?l|s\.?n\.?c|s\.?a\.?s|s\.?p\.?a|cooperativ|consorzio/.test(f)) return 'con_operai';
  if (/individual|ditta|impresa individuale|artigian/.test(f)) {
    if (n === null) return null;
    return n <= 1 ? 'da_solo' : 'con_operai';
  }
  return null;
}

module.exports = { TIPI, tipoDi, tipoDaVisura };
