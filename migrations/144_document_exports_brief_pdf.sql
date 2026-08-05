-- Migration 144 — aggiunge 'brief_pdf' ai tipi di export consentiti in
-- document_exports (Fase 3.3 "Ciclo del Risultato" — export del briefing
-- giornaliero di Ladia). Senza questo, l'insert in logDocumentExport fallisce
-- silenziosamente (best-effort, try/catch) e il PDF viene comunque scaricato
-- ma non contato come "documento generato" nel layer proof-of-value.

ALTER TABLE document_exports DROP CONSTRAINT document_exports_export_type_check;

ALTER TABLE document_exports ADD CONSTRAINT document_exports_export_type_check
  CHECK (export_type IN (
    'contratto_subappalto', 'report_chat_pdf', 'report_chat_excel', 'report_vigilanza', 'brief_pdf'
  ));
