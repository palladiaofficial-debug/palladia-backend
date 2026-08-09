-- 156_documents_tier3_schema.sql
-- Fase 2, Scaglione 3 — passo "expand". Estende `documents` per coprire
-- ladia_document_templates (solo sync, nessuna UI), studio_shared_documents
-- e studio_document_requests. Puramente additivo: nessuna colonna esistente
-- viene rimossa o ristretta, nessuna tabella storica perde dati.
--
-- owner_type NON va esteso: tutte e 3 le tabelle sono company-level, riusano
-- 'company' (a differenza dello Scaglione 2 che aggiunse 'subcontractor').

-- ── documents: nuove colonne, tutte specifiche di studio_document_requests ──
ALTER TABLE documents ADD COLUMN IF NOT EXISTS request_status    text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS due_date          date;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS response_url      text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS response_filename text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS response_notes    text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewer_notes    text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS upload_token      text;

CREATE INDEX IF NOT EXISTS idx_documents_request_status
  ON documents(request_status) WHERE request_status IS NOT NULL;
