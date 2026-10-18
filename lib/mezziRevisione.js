'use strict';
/**
 * lib/mezziRevisione.js — F-375 (AUDIT.md del frontend): la revisione la calcola Palladia.
 *
 * Art. 80 del Codice della strada:
 *  - autovetture, motocicli, ciclomotori, autocarri fino a 3,5 t: la prima
 *    entro 4 anni dalla prima immatricolazione, poi ogni 2 anni;
 *  - autocarri e rimorchi oltre 3,5 t (e autobus, taxi): ogni anno;
 *  - la scadenza è la fine del mese (il mese dell'immatricolazione per la
 *    prima, il mese dell'ultima revisione fatta per le altre).
 * Prima la regola stava nel prompt del modello (POST /equipment/ocr) e non la
 * controllava nessuno: qui è codice, con i suoi test.
 *
 * Se si conosce l'ultima revisione fatta si parte da quella. Se si conosce solo
 * l'immatricolazione e la prima è già passata, si presume che le revisioni
 * siano state fatte in regola (`presunta: true`): la schermata lo dice, e il
 * titolare può cambiare la data.
 */

const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const giorno = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null);

/** Ultimo giorno del mese di `d` spostato di `anni`. */
function fineMese(d, anni) {
  return new Date(Date.UTC(d.getUTCFullYear() + anni, d.getUTCMonth() + 1, 0));
}

/**
 * @param {{ immatricolazione?: string|null, ultima?: string|null, massaKg?: number|null }} m
 * @param {string} [oggiIso] YYYY-MM-DD (per i test)
 * @returns {null | { data: string, pesante: boolean, presunta: boolean, daUltima: boolean, regola: string }}
 */
function prossimaRevisione({ immatricolazione = null, ultima = null, massaKg = null } = {}, oggiIso = null) {
  const imm = giorno(immatricolazione);
  const ult = giorno(ultima);
  if (!imm && !ult) return null;
  const oggi = giorno(oggiIso) || giorno(new Date().toISOString());
  const pesante = Number(massaKg) > 3500;
  const ogni = pesante ? 1 : 2;
  const prima = pesante ? 1 : 4;
  const regola = pesante
    ? 'Oltre 3,5 t la revisione è ogni anno.'
    : 'Fino a 3,5 t la prima revisione è dopo 4 anni, poi ogni 2.';

  // L'ultima revisione fatta vale più dell'immatricolazione (anche se in ritardo)
  if (ult && (!imm || ult >= imm)) {
    return { data: iso(fineMese(ult, ogni)), pesante, presunta: false, daUltima: true, regola };
  }
  let data = fineMese(imm, prima);
  let presunta = false;
  while (data < oggi) { data = fineMese(data, ogni); presunta = true; }
  return { data: iso(data), pesante, presunta, daUltima: false, regola };
}

module.exports = { prossimaRevisione };
