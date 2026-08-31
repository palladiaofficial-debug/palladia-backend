'use strict';
/**
 * lib/equipmentExpirySuggest.js
 * Confronta le date lette dall'OCR di un documento mezzo (libretto/
 * assicurazione/revisione) con quelle già registrate su `equipment`, e
 * propone un aggiornamento SENZA mai scriverlo da solo.
 *
 * Trovato nello sweep F-105 (AUDIT.md): un documento caricato su un mezzo
 * (via chat O manualmente) non aggiornava mai equipment.insurance_expiry/
 * inspection_date — il campo che genera davvero gli alert di scadenza
 * (services/equipmentExpiryCron.js). A differenza di worker_documents,
 * qui non c'è un "percorso manuale che già lo fa" da replicare: nessuno dei
 * due lo faceva. Scrivere in automatico dall'estrazione AI rischierebbe di
 * sovrascrivere silenziosamente una data corretta con una letta male
 * dall'OCR — quindi questo modulo si limita a CALCOLARE la proposta; la
 * scrittura vera passa sempre da una conferma esplicita (PATCH /equipment/:id
 * per il percorso manuale, update_record dopo conferma in chat per Ladia).
 */

// Solo questi due campi sono derivabili da un libretto/assicurazione — non
// esiste un documento standard da cui leggere la data del tagliando
// (maintenance_date resta editabile solo a mano, fuori scope qui).
const FIELD_MAP = [
  { aiField: 'data_scadenza_assicurazione', eqField: 'insurance_expiry', label: 'Assicurazione' },
  { aiField: 'data_prossima_revisione',     eqField: 'inspection_date',  label: 'Revisione' },
];

function isValidIsoDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * @param {object|null} currentEquipment - riga equipment corrente (almeno insurance_expiry, inspection_date)
 * @param {object|null} aiExtracted - output di sanitizeExtractedFields sull'OCR del documento
 * @returns {Array<{field: string, label: string, current: string|null, suggested: string}>} — vuoto se nessuna differenza
 */
function suggestEquipmentExpiryUpdates(currentEquipment, aiExtracted) {
  if (!aiExtracted || !currentEquipment) return [];
  const suggestions = [];
  for (const { aiField, eqField, label } of FIELD_MAP) {
    const suggested = aiExtracted[aiField];
    if (!isValidIsoDate(suggested)) continue; // OCR non ha letto una data valida — nessuna proposta
    const current = currentEquipment[eqField] || null;
    if (current === suggested) continue; // già allineato, nessuna proposta da fare
    suggestions.push({ field: eqField, label, current, suggested });
  }
  return suggestions;
}

module.exports = { suggestEquipmentExpiryUpdates, FIELD_MAP };
