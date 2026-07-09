-- Migration 130: analisi AI automatica anche sui documenti di cantiere
--
-- company_documents e worker_documents hanno già questo meccanismo dalla
-- migrazione 050 (services/documentAI.js, Haiku su PDF con testo, Sonnet
-- solo su scansioni/immagini). site_documents (tab "Documenti" di un
-- cantiere) non l'ha mai avuto: un file caricato lì viene solo salvato,
-- Ladia lo legge solo se esplicitamente richiesto durante una conversazione
-- (leggi_documento_pdf), niente scadenza/riassunto pronti in anticipo.

ALTER TABLE site_documents
  ADD COLUMN IF NOT EXISTS ai_summary        text,
  ADD COLUMN IF NOT EXISTS ai_expiry_date    date,
  ADD COLUMN IF NOT EXISTS ai_renewal_years  integer,
  ADD COLUMN IF NOT EXISTS ai_issued_by      text,
  ADD COLUMN IF NOT EXISTS ai_issues         text[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_validity_ok    boolean,
  ADD COLUMN IF NOT EXISTS ai_analyzed_at    timestamptz;

CREATE INDEX IF NOT EXISTS idx_site_docs_ai
  ON site_documents (ai_analyzed_at) WHERE ai_analyzed_at IS NULL;
