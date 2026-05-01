-- Migration 050: campi AI su company_documents e worker_documents
-- Aggiunge analisi automatica Claude: scadenze, rinnovi, problemi, ente emittente.
-- worker_documents: aggiunge file_path per upload diretto su Supabase Storage.

-- ── company_documents ─────────────────────────────────────────────────────────
ALTER TABLE company_documents
  ADD COLUMN IF NOT EXISTS ai_summary        text,
  ADD COLUMN IF NOT EXISTS ai_expiry_date    date,
  ADD COLUMN IF NOT EXISTS ai_renewal_years  integer,
  ADD COLUMN IF NOT EXISTS ai_issued_by      text,
  ADD COLUMN IF NOT EXISTS ai_issues         text[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_validity_ok    boolean,
  ADD COLUMN IF NOT EXISTS ai_analyzed_at    timestamptz;

-- ── worker_documents ──────────────────────────────────────────────────────────
ALTER TABLE worker_documents
  ADD COLUMN IF NOT EXISTS file_path         text,
  ADD COLUMN IF NOT EXISTS mime_type         text,
  ADD COLUMN IF NOT EXISTS ai_summary        text,
  ADD COLUMN IF NOT EXISTS ai_expiry_date    date,
  ADD COLUMN IF NOT EXISTS ai_renewal_years  integer,
  ADD COLUMN IF NOT EXISTS ai_issued_to      text,
  ADD COLUMN IF NOT EXISTS ai_issued_by      text,
  ADD COLUMN IF NOT EXISTS ai_issues         text[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_validity_ok    boolean,
  ADD COLUMN IF NOT EXISTS ai_analyzed_at    timestamptz;

-- Indice per trovare rapidamente documenti non ancora analizzati
CREATE INDEX IF NOT EXISTS idx_company_docs_ai
  ON company_documents (ai_analyzed_at) WHERE ai_analyzed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_worker_docs_ai
  ON worker_documents (ai_analyzed_at) WHERE ai_analyzed_at IS NULL;
