-- Migration 078: Studio Document Requests
-- Il CDL può inviare richieste di documenti ai clienti.
-- Il cliente riceve il link upload (pubblico + token) e carica il file.
-- Il CDL vede il documento caricato nel portale.

CREATE TABLE IF NOT EXISTS studio_document_requests (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id            UUID        NOT NULL REFERENCES studio_partners(id) ON DELETE CASCADE,
  company_id           UUID        NOT NULL REFERENCES companies(id),
  title                TEXT        NOT NULL,
  description          TEXT,
  document_type        TEXT        NOT NULL DEFAULT 'altro'
                                   CHECK (document_type IN ('durc','visura','dvr','polizza','certificato','idoneita','verbale','contratto','altro')),
  due_date             DATE,
  status               TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending','uploaded','reviewed','rejected')),
  upload_token         TEXT        UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  response_url         TEXT,
  response_filename    TEXT,
  response_notes       TEXT,
  reviewer_notes       TEXT,
  response_uploaded_at TIMESTAMPTZ,
  reviewed_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sdr_studio  ON studio_document_requests(studio_id);
CREATE INDEX IF NOT EXISTS idx_sdr_company ON studio_document_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_sdr_token   ON studio_document_requests(upload_token);
CREATE INDEX IF NOT EXISTS idx_sdr_status  ON studio_document_requests(status);
