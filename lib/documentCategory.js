'use strict';
/**
 * lib/documentCategory.js
 * Le colonne category di site_documents e company_documents hanno un CHECK
 * constraint a livello DB (migrazioni 049, 167) — un valore fuori lista fa
 * fallire l'INSERT con un errore Postgres grezzo invece di archiviare il
 * documento. Estratto da services/smartImportPipeline.js (dove già esisteva)
 * per essere condiviso anche da services/chatDocumentAnalysis.js senza
 * creare un require circolare tra i due moduli (smartImportPipeline importa
 * archiveChatUpload da chatDocumentAnalysis).
 */

const CATEGORY_ALLOWLIST = {
  site_documents:    new Set(['pos', 'psc', 'notifica_asl', 'durc', 'dvr', 'assicurazione', 'contratto', 'capitolato', 'altro']),
  company_documents: new Set(['rspp', 'rls', 'medico_competente', 'visite_mediche', 'primo_soccorso', 'emergenze', 'preposto', 'dvr', 'duvri', 'formazione', 'durc', 'visura', 'iso', 'soa', 'assicurazione', 'polizza', 'f24', 'contratto', 'capitolato', 'patente_crediti', 'dichiarazione_art14', 'altro']),  // F-421: migrazione 265
};

function sanitizeCategory(destination, docType) {
  const allowed = CATEGORY_ALLOWLIST[destination];
  if (!allowed) return docType || 'altro'; // worker_documents/worker_certificates: doc_type libero, nessun CHECK
  return allowed.has(docType) ? docType : 'altro';
}

/**
 * F-506 (AUDIT.md): il nome con cui un documento si salva. Mai il codice del
 * tipo («altro», «busta_paga»): in Documenti diventava «Documento senza nome».
 * Al suo posto il nome del file, senza estensione (anche prima di « (pag. 3-5)»).
 */
const CODICE_RE = /^[a-z_]+$/;
function nomeLeggibile(nome, nomeFile) {
  const n = String(nome || '').trim();
  if (n && !CODICE_RE.test(n)) return n;
  const f = String(nomeFile || '').trim().replace(/\.(pdf|jpe?g|png|webp|heic|docx?|xlsx?)(?=\s*\(pag\.|$)/i, '').trim();
  return f || 'Documento';
}

module.exports = { CATEGORY_ALLOWLIST, sanitizeCategory, nomeLeggibile };
