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
  company_documents: new Set(['rspp', 'rls', 'medico_competente', 'visite_mediche', 'primo_soccorso', 'emergenze', 'preposto', 'dvr', 'duvri', 'formazione', 'durc', 'visura', 'iso', 'soa', 'assicurazione', 'polizza', 'f24', 'contratto', 'capitolato', 'altro']),
};

function sanitizeCategory(destination, docType) {
  const allowed = CATEGORY_ALLOWLIST[destination];
  if (!allowed) return docType || 'altro'; // worker_documents/worker_certificates: doc_type libero, nessun CHECK
  return allowed.has(docType) ? docType : 'altro';
}

module.exports = { CATEGORY_ALLOWLIST, sanitizeCategory };
