-- Migration 136 — Importazione Intelligente: tabelle di staging
-- Trasforma la pipeline zip Studio CDL (chat_uploads + analisi AI diretta in
-- produzione) in un flusso con revisione umana obbligatoria: import_batches
-- (una importazione) → import_items (un documento, o un frammento se un PDF
-- ne conteneva più di uno) → import_staged_entities (lavoratori/cantieri
-- nuovi proposti, deduplicati dentro il batch). Nulla scrive nelle tabelle
-- di produzione finché l'utente non conferma.

CREATE TABLE import_batches (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL,
  status          text        NOT NULL DEFAULT 'uploading'
                              CHECK (status IN ('uploading', 'queued', 'processing', 'review', 'confirmed', 'cancelled')),
  source          text        NOT NULL CHECK (source IN ('zip', 'folder')),
  total_files     int         NOT NULL DEFAULT 0,
  processed_files int         NOT NULL DEFAULT 0,
  summary         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_import_batches_company ON import_batches (company_id);

CREATE TABLE import_staged_entities (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           uuid        NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  entity_type        text        NOT NULL CHECK (entity_type IN ('worker', 'site')),
  match_key          text        NOT NULL, -- CF normalizzato (worker) o nome+indirizzo normalizzato (site) — dedup dentro il batch
  extracted_data     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status             text        NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'rejected')),
  created_entity_id  uuid,       -- worker_id o site_id dopo la conferma
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_staged_entities_unique UNIQUE (batch_id, entity_type, match_key)
);
CREATE INDEX idx_import_staged_entities_batch ON import_staged_entities (batch_id);

CREATE TABLE import_items (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                  uuid        NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  chat_upload_id            uuid        REFERENCES chat_uploads (id) ON DELETE SET NULL,
  parent_item_id            uuid        REFERENCES import_items (id) ON DELETE CASCADE,
  page_start                int,
  page_end                  int,
  original_name             text        NOT NULL,
  content_hash              text,
  doc_type                  text,
  destination               text        CHECK (destination IN ('site_documents', 'company_documents', 'worker_documents', 'worker_certificates')),
  extracted_fields          jsonb       NOT NULL DEFAULT '{}'::jsonb, -- { campo: {value, confidence} }
  overall_confidence        numeric,
  matched_worker_id         uuid        REFERENCES workers (id) ON DELETE SET NULL,
  matched_site_id           uuid        REFERENCES sites (id) ON DELETE SET NULL,
  worker_match_score        int,
  site_match_score          int,
  staged_worker_id          uuid        REFERENCES import_staged_entities (id) ON DELETE SET NULL,
  staged_site_id            uuid        REFERENCES import_staged_entities (id) ON DELETE SET NULL,
  duplicate_of_table        text,
  duplicate_of_document_id  uuid,
  status                    text        NOT NULL DEFAULT 'queued'
                                        CHECK (status IN ('queued', 'processing', 'needs_split', 'pending_review', 'duplicate', 'error', 'confirmed', 'rejected')),
  error_message             text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_import_items_batch  ON import_items (batch_id);
CREATE INDEX idx_import_items_status ON import_items (status);
CREATE INDEX idx_import_items_parent ON import_items (parent_item_id);

-- chat_uploads: collega ogni file (o frammento splittato) al batch e abilita
-- il dedup per hash del contenuto.
ALTER TABLE chat_uploads
  ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES import_batches (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS content_hash    text;
CREATE INDEX IF NOT EXISTS idx_chat_uploads_batch ON chat_uploads (import_batch_id);

-- Hash del contenuto sulle tabelle di produzione — dedup contro documenti già
-- importati in passato (non solo dentro il batch corrente).
ALTER TABLE site_documents      ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE company_documents   ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE worker_documents    ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE worker_certificates ADD COLUMN IF NOT EXISTS content_hash text;
CREATE INDEX IF NOT EXISTS idx_site_documents_hash      ON site_documents      (company_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_company_documents_hash   ON company_documents   (company_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_worker_documents_hash    ON worker_documents    (company_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_worker_certificates_hash ON worker_certificates (company_id, content_hash);

-- RLS — stesso pattern restrittivo di chat_uploads: il creatore del batch
-- vede i propri dati, il backend scrive con service_role.
ALTER TABLE import_batches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_staged_entities  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "import_batches_select_own"
  ON import_batches FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "import_items_select_own"
  ON import_items FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM import_batches b
    WHERE b.id = import_items.batch_id AND b.user_id = auth.uid()
  ));

CREATE POLICY "import_staged_entities_select_own"
  ON import_staged_entities FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM import_batches b
    WHERE b.id = import_staged_entities.batch_id AND b.user_id = auth.uid()
  ));

-- Nessuna policy INSERT/UPDATE per authenticated: l'intero flusso (classificazione,
-- estrazione, conferma) è orchestrato dal backend con service_role.
