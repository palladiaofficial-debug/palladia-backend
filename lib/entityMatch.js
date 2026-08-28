'use strict';
/**
 * lib/entityMatch.js
 * Matching lavoratore/cantiere per l'Importazione Intelligente — estende
 * lib/fuzzyMatch.js (già usato dal flusso zip in chat) aggiungendo il match
 * esatto sul codice fiscale (estratto ma mai usato nel flusso precedente) e
 * il match su indirizzo cantiere. Non tocca fuzzyMatch.js: lo riusa.
 */

const { bestMatch, normName } = require('./fuzzyMatch');

const WORKER_MATCH_THRESHOLD    = 55;
const SITE_MATCH_THRESHOLD      = 55;
const EQUIPMENT_MATCH_THRESHOLD = 55;

function normCf(cf) {
  return (cf || '').toUpperCase().replace(/\s/g, '');
}

function normPlate(plate) {
  return (plate || '').toUpperCase().replace(/[\s.-]/g, '');
}

/**
 * candidates: [{ id, full_name, fiscal_code }]
 * Ritorna { id, name, score, matchedBy: 'cf'|'name' } o null.
 */
function matchWorker(extracted, candidates) {
  const cf = normCf(extracted.fiscal_code);
  if (cf) {
    const exact = candidates.find(c => normCf(c.fiscal_code) === cf);
    if (exact) return { id: exact.id, name: exact.full_name, score: 100, matchedBy: 'cf' };
  }
  const nameCandidates = candidates.map(c => ({ id: c.id, name: c.full_name }));
  const m = bestMatch(extracted.name, nameCandidates, 'name', WORKER_MATCH_THRESHOLD);
  return m ? { ...m, matchedBy: 'name' } : null;
}

/**
 * candidates: [{ id, name, address }]
 * Prova prima l'indirizzo (più affidabile per un cantiere), poi il nome.
 */
function matchSite(extracted, candidates) {
  const hintAddr = normName(extracted.address);
  if (hintAddr) {
    const exact = candidates.find(c => normName(c.address) && normName(c.address) === hintAddr);
    if (exact) return { id: exact.id, name: exact.name, score: 100, matchedBy: 'address' };
  }
  const nameCandidates = candidates.map(c => ({ id: c.id, name: c.name }));
  const m = bestMatch(extracted.name, nameCandidates, 'name', SITE_MATCH_THRESHOLD);
  return m ? { ...m, matchedBy: 'name' } : null;
}

/**
 * candidates: [{ id, name, type, model, plate_or_serial }]
 * Prova prima la targa/matricola (più affidabile, come il CF per un lavoratore),
 * poi nome/tipo+modello.
 */
function matchEquipment(extracted, candidates) {
  const plate = normPlate(extracted.plate);
  if (plate) {
    const exact = candidates.find(c => normPlate(c.plate_or_serial) === plate);
    if (exact) return { id: exact.id, name: exact.name || exact.model, score: 100, matchedBy: 'plate' };
  }
  // Un mezzo ha spesso un nome interno (es. "Furgone Cantiere Nord") diverso
  // da marca/modello (es. "Ducato") citati nel documento — proviamo entrambi
  // come candidati indipendenti sullo stesso id, non solo il nome se presente
  // (altrimenti un documento che cita solo il modello non troverebbe mai
  // match su un mezzo con un nome interno impostato).
  const nameCandidates = candidates.flatMap(c => {
    const variants = [];
    if (c.name) variants.push({ id: c.id, name: c.name });
    if (c.model) variants.push({ id: c.id, name: c.model });
    const typeModel = [c.type, c.model].filter(Boolean).join(' ');
    if (typeModel) variants.push({ id: c.id, name: typeModel });
    return variants;
  });
  const m = bestMatch(extracted.name, nameCandidates, 'name', EQUIPMENT_MATCH_THRESHOLD);
  return m ? { ...m, matchedBy: 'name' } : null;
}

module.exports = {
  matchWorker, matchSite, matchEquipment, normCf,
  WORKER_MATCH_THRESHOLD, SITE_MATCH_THRESHOLD, EQUIPMENT_MATCH_THRESHOLD,
};
