'use strict';

// F-078: stesso pattern strutturale di F-066/067/069/070/077 — l'IA che legge
// un'offerta/listino fornitore (routes/v1/prezzario.js, POST /parse-offerta)
// risponde con JSON via prompt testuale, nessuno schema imposto. Su un
// documento con voci strutturate (es. descrizione con sotto-specifiche) un
// campo atteso come stringa può arrivare come oggetto annidato: chiamarci
// `.trim()` sopra lancia TypeError (fallimento totale dell'endpoint, non solo
// un valore sporco), e un `fornitore` non tipizzato passerebbe intatto al
// frontend con lo stesso rischio di crash React #31 già visto altrove.
const CATEGORIE = ['Materiali', 'Manodopera', 'Noli', 'Trasporti', 'Subappalto', 'Forniture', 'Altro'];

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeOfferItems(parsed) {
  const fornitoreGlobale = asText(parsed?.fornitore).trim().slice(0, 100) || null;
  const items = (Array.isArray(parsed?.items) ? parsed.items : [])
    .filter((it) => asText(it?.descrizione).trim() && it?.prezzo != null && !isNaN(parseFloat(it.prezzo)))
    .map((it) => ({
      descrizione: asText(it.descrizione).trim().slice(0, 200),
      um:          asText(it.um).trim() || null,
      prezzo:      parseFloat(it.prezzo),
      categoria:   CATEGORIE.includes(it.categoria) ? it.categoria : 'Altro',
      fornitore:   (asText(it.fornitore).trim() || fornitoreGlobale) || null,
    }));

  return {
    fornitore:    fornitoreGlobale,
    data_offerta: typeof parsed?.data_offerta === 'string' ? parsed.data_offerta : null,
    items,
  };
}

module.exports = { normalizeOfferItems, CATEGORIE };
