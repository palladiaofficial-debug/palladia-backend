'use strict';
// ── F-485: uscita per pioggia entro le 10 = pioggia tutto il giorno ─────────
// Regola dell'impresa (MSC, confermata dal datore di lavoro il 10/11/2026):
// quando piove si aspetta fino a un'ora limite (le 10) per vedere se smette.
// Chi esce per pioggia entro quell'ora ha «pioggia tutto il giorno»; chi esce
// dopo ha le ore lavorate e il resto di pioggia (conteggio normale).
// È un'impostazione dell'impresa (companies.pioggia_giorno_intero_entro, ora
// HH:MM; null = spenta): non è scritta come legge, la decide chi fa le buste.

const toMin = (t) => {
  if (t == null || t === '') return null;
  const [h, m] = String(t).split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
};
const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

/**
 * Se il giorno rientra nella regola, lo trasforma in «pioggia tutto il giorno»
 * (muta la cella del mese di lib/oreMese.js) e restituisce true.
 * @param {object} cell  cella del mese (tipo, ore, straord, maltempoMin, ultimaUscita, perCantiere…)
 * @param {{ limite: string|null, tolleranza?: number, contratto: number, motivo: string|null, forza?: boolean|null }} o
 *   forza (F-486) = decisione dell'ufficio per quel giorno: true = tutto il giorno, false = no, null = regola
 *   motivo = motivo dell'uscita ('maltempo' = pioggia, 'caldo', …) oppure 'maltempo' per una pioggia confermata dall'ufficio
 */
function applicaPioggiaGiornoIntero(cell, { limite, tolleranza = 0, contratto, motivo, forza = null }) {
  if (!cell || cell.tipo !== 'lavoro') return false;
  if (motivo !== 'maltempo' || !(cell.maltempoMin > 0)) return false; // solo pioggia, non caldo né permessi
  if (forza === false) return false; // F-486: l'ufficio ha detto «no»: ore lavorate + pioggia
  if (forza !== true) {
    const lim = toMin(limite);
    if (lim == null) return false;
    if (cell.straord > 0) return false; // rientrato e rimasto oltre l'orario: ha lavorato davvero
    const uscita = toMin(cell.ultimaUscita);
    if (uscita == null || uscita > lim + (tolleranza || 0)) return false;
  }
  cell.pioggiaGiornoIntero = { oreLavorate: cell.ore || 0, uscita: hhmm(cell.ultimaUscita), entro: forza === true ? null : hhmm(limite), decisoUfficio: forza === true };
  cell.ore = 0;
  cell.maltempoMin = contratto;
  cell.permessoMin = 0; cell.malattiaMin = 0; cell.infortunioMin = 0;
  cell.perCantiere = {};
  cell.uscitoPrima = 0;
  cell.mancantiMin = 0;
  cell.tipo = 'maltempo';
  return true;
}

module.exports = { applicaPioggiaGiornoIntero };
