-- 150_documents_unified_tier1.sql
-- Fase 2 (gestione documentale unificata), Scaglione 1 — passo "expand".
-- Crea la tabella unificata `documents` e le sue dipendenze. Puramente
-- additivo: nessuna tabella storica viene toccata da questa migrazione.
-- Le tabelle storiche restano l'unica fonte di verità finché non verrà
-- deciso, esplicitamente e più avanti, un cutover delle scritture.
--
-- Copre lo Scaglione 1: site_documents, company_documents, worker_documents,
-- worker_certificates — le 4 già trattate come equivalenti da
-- import_items.destination (migrazione 136).

CREATE TABLE IF NOT EXISTS documents (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_type          text        NOT NULL CHECK (owner_type IN ('site','company','worker')),
  site_id             uuid        REFERENCES sites(id) ON DELETE CASCADE,
  worker_id           uuid        REFERENCES workers(id) ON DELETE CASCADE,

  name                text,
  category            text,
  bucket              text        NOT NULL DEFAULT 'site-documents',
  -- nullable: worker_documents/worker_certificates ammettono record di sola
  -- compliance (es. "idoneità medica" con solo le date) senza file allegato —
  -- scoperto dal vivo durante il backfill (riga reale senza file_path/file_url)
  file_path           text,
  file_path_needs_review boolean  NOT NULL DEFAULT false,
  file_size           bigint,
  mime_type           text,

  issued_date         date,
  expiry_date         date,
  ai_expiry_date      date,
  ai_summary          text,
  ai_renewal_years    integer,
  ai_issued_by        text,
  ai_issued_to        text,
  ai_issues           text,
  ai_validity_ok      boolean,
  ai_analyzed_at      timestamptz,
  content_hash        text,

  -- solo worker_certificates
  course_type_id      uuid REFERENCES course_types(id),
  certificate_number  text,
  issuing_body        text,

  notes               text,
  uploaded_by         uuid,
  deleted_at          timestamptz,

  -- leva di reversibilità: da quale tabella/riga storica arriva questa riga
  source_table        text        NOT NULL,
  legacy_id           uuid        NOT NULL,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source_table, legacy_id)
);

-- Idempotente: se la tabella esisteva già da un run precedente di questa
-- migrazione con file_path NOT NULL, la rilassa (safe anche se già nullable).
ALTER TABLE documents ALTER COLUMN file_path DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_company     ON documents(company_id);
CREATE INDEX IF NOT EXISTS idx_documents_site         ON documents(site_id) WHERE site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_worker        ON documents(worker_id) WHERE worker_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_category      ON documents(category);
CREATE INDEX IF NOT EXISTS idx_documents_expiry        ON documents(expiry_date) WHERE expiry_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_content_hash  ON documents(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_needs_review  ON documents(company_id) WHERE file_path_needs_review;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "documents_company_member" ON documents;
CREATE POLICY "documents_company_member"
  ON documents FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

-- ── Log delle sincronizzazioni fallite ──────────────────────────────────────
-- Tabella operativa interna, non per-tenant: RLS abilitato SENZA policy per il
-- ruolo authenticated (deny-all deliberato — solo il backend service-role la
-- legge/scrive, stesso principio corretto scoperto per errore con F-031).
CREATE TABLE IF NOT EXISTS document_sync_failures (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table   text        NOT NULL,
  legacy_id      uuid,
  operation      text        NOT NULL,
  error_message  text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_document_sync_failures_unresolved
  ON document_sync_failures(source_table, occurred_at) WHERE resolved_at IS NULL;
ALTER TABLE document_sync_failures ENABLE ROW LEVEL SECURITY;

-- ── Helper: estrae bucket + object key da un path raw o da una signed/public URL ──
-- I dati reali mostrano che worker_certificates.pdf_url può contenere path raw,
-- signed URL sul bucket site-documents O sul bucket documents (mai un pattern
-- unico) — questa funzione normalizza tutti i casi in modo esplicito.
CREATE OR REPLACE FUNCTION extract_storage_ref(raw text)
RETURNS TABLE(bucket text, object_path text) AS $$
DECLARE
  m text[];
BEGIN
  IF raw IS NULL OR raw = '' THEN
    RETURN;
  END IF;
  IF raw !~ '^https?://' THEN
    bucket := 'site-documents'; object_path := raw; RETURN NEXT; RETURN;
  END IF;
  m := regexp_match(raw, '/object/(?:sign|public)/([a-z0-9\-]+)/([^?]+)');
  IF m IS NULL THEN
    bucket := NULL; object_path := NULL; RETURN NEXT; RETURN;
  END IF;
  bucket := m[1];
  object_path := m[2];
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
