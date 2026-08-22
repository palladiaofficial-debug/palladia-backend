'use strict';

// L'IA che legge documenti mezzo (routes/v1/equipment.js) restituisce testo
// libero interpretato come JSON: nessuno schema imposto a livello di tool/
// structured-output, solo un'istruzione nel prompt. Su un documento molto
// denso (es. carta di circolazione ufficiale, molti più campi del previsto)
// il modello a volte impacchetta i dati "extra" come oggetto annidato invece
// di testo semplice (riprodotto dal vivo — F-066): quel valore, passato così
// com'è al frontend e renderizzato come figlio React, causa un crash
// immediato (errore #31, "Objects are not valid as a React child"). Ogni
// campo va quindi ricondotto a testo semplice prima di rispondere.
function flattenToText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const joined = value.map(flattenToText).filter(Boolean).join(', ');
    return joined || null;
  }
  if (typeof value === 'object') {
    const joined = Object.entries(value)
      .map(([k, v]) => { const t = flattenToText(v); return t ? `${k}: ${t}` : null; })
      .filter(Boolean)
      .join('; ');
    return joined || null;
  }
  return String(value);
}

function sanitizeExtractedFields(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(obj)) out[key] = flattenToText(value);
  return out;
}

module.exports = { sanitizeExtractedFields, flattenToText };
