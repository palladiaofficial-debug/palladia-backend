-- 157_documents_tier3_sync_triggers.sql
-- Fase 2, Scaglione 3 — passo "sync". Stesso identico pattern degli Scaglioni
-- 1/2 (migrazioni 151/154): trigger AFTER INSERT/UPDATE/DELETE, ogni funzione
-- avvolta in EXCEPTION WHEN OTHERS a due livelli (la sync non può MAI far
-- fallire la scrittura storica, nemmeno se il logging del fallimento stesso
-- fallisce), backfill idempotente con source_table/legacy_id.

-- ── ladia_document_templates ─────────────────────────────────────────────────
-- Solo sync dati (nessun adapter frontend): entra nell'archivio/ricerca
-- unificata lato Ladia. storage_path è nullable by design applicativo
-- (services/ladiaDocumentProcessor.js salva anche se l'upload storage
-- fallisce) — la sync tollera NULL, stesso principio di worker_documents
-- nello Scaglione 1. uploaded_by_chat_id è un chat id Telegram testuale, non
-- uno uuid Supabase Auth: uploaded_by resta sempre NULL per queste righe.
CREATE OR REPLACE FUNCTION sync_ladia_document_templates_to_documents() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM documents WHERE source_table = 'ladia_document_templates' AND legacy_id = OLD.id;
    ELSE
      INSERT INTO documents (
        company_id, owner_type, name, category, bucket, file_path,
        file_size, ai_summary, uploaded_by,
        source_table, legacy_id, created_at, updated_at
      ) VALUES (
        NEW.company_id, 'company', NEW.original_filename, NEW.document_type, 'site-documents', NEW.storage_path,
        NEW.file_size_bytes, NEW.summary, NULL,
        'ladia_document_templates', NEW.id, NEW.created_at, now()
      )
      ON CONFLICT (source_table, legacy_id) DO UPDATE SET
        company_id = EXCLUDED.company_id, name = EXCLUDED.name, category = EXCLUDED.category,
        file_path = EXCLUDED.file_path, file_size = EXCLUDED.file_size, ai_summary = EXCLUDED.ai_summary,
        updated_at = now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO document_sync_failures (source_table, legacy_id, operation, error_message)
      VALUES ('ladia_document_templates', COALESCE(NEW.id, OLD.id), TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_ladia_document_templates ON ladia_document_templates;
CREATE TRIGGER trg_sync_ladia_document_templates
  AFTER INSERT OR UPDATE OR DELETE ON ladia_document_templates
  FOR EACH ROW EXECUTE FUNCTION sync_ladia_document_templates_to_documents();

-- ── studio_shared_documents ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_studio_shared_documents_to_documents() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM documents WHERE source_table = 'studio_shared_documents' AND legacy_id = OLD.id;
    ELSE
      INSERT INTO documents (
        company_id, owner_type, studio_id, name, category, bucket, file_path,
        file_size, mime_type, notes, uploaded_by,
        source_table, legacy_id, created_at, updated_at
      ) VALUES (
        NEW.company_id, 'company', NEW.studio_id, NEW.name, NEW.category, 'site-documents', NEW.file_path,
        NEW.file_size, NEW.mime_type, NEW.description, NEW.created_by,
        'studio_shared_documents', NEW.id, NEW.created_at, now()
      )
      ON CONFLICT (source_table, legacy_id) DO UPDATE SET
        company_id = EXCLUDED.company_id, studio_id = EXCLUDED.studio_id, name = EXCLUDED.name,
        category = EXCLUDED.category, file_path = EXCLUDED.file_path, file_size = EXCLUDED.file_size,
        mime_type = EXCLUDED.mime_type, notes = EXCLUDED.notes, uploaded_by = EXCLUDED.uploaded_by,
        updated_at = now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO document_sync_failures (source_table, legacy_id, operation, error_message)
      VALUES ('studio_shared_documents', COALESCE(NEW.id, OLD.id), TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_studio_shared_documents ON studio_shared_documents;
CREATE TRIGGER trg_sync_studio_shared_documents
  AFTER INSERT OR UPDATE OR DELETE ON studio_shared_documents
  FOR EACH ROW EXECUTE FUNCTION sync_studio_shared_documents_to_documents();

-- ── studio_document_requests ─────────────────────────────────────────────────
-- response_url NON è un path su bucket Supabase: è un link esterno incollato
-- dal cliente (Google Drive/Dropbox/WeTransfer, vedi StudioUpload.tsx) —
-- resta fuori da file_path/bucket, mappato solo su response_url dedicata.
CREATE OR REPLACE FUNCTION sync_studio_document_requests_to_documents() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM documents WHERE source_table = 'studio_document_requests' AND legacy_id = OLD.id;
    ELSE
      INSERT INTO documents (
        company_id, owner_type, studio_id, name, category, notes, due_date,
        request_status, response_url, response_filename, response_notes,
        reviewer_notes, upload_token,
        source_table, legacy_id, created_at, updated_at
      ) VALUES (
        NEW.company_id, 'company', NEW.studio_id, NEW.title, NEW.document_type, NEW.description, NEW.due_date,
        NEW.status, NEW.response_url, NEW.response_filename, NEW.response_notes,
        NEW.reviewer_notes, NEW.upload_token,
        'studio_document_requests', NEW.id, NEW.created_at, COALESCE(NEW.updated_at, now())
      )
      ON CONFLICT (source_table, legacy_id) DO UPDATE SET
        company_id = EXCLUDED.company_id, studio_id = EXCLUDED.studio_id, name = EXCLUDED.name,
        category = EXCLUDED.category, notes = EXCLUDED.notes, due_date = EXCLUDED.due_date,
        request_status = EXCLUDED.request_status, response_url = EXCLUDED.response_url,
        response_filename = EXCLUDED.response_filename, response_notes = EXCLUDED.response_notes,
        reviewer_notes = EXCLUDED.reviewer_notes, upload_token = EXCLUDED.upload_token,
        updated_at = now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO document_sync_failures (source_table, legacy_id, operation, error_message)
      VALUES ('studio_document_requests', COALESCE(NEW.id, OLD.id), TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_studio_document_requests ON studio_document_requests;
CREATE TRIGGER trg_sync_studio_document_requests
  AFTER INSERT OR UPDATE OR DELETE ON studio_document_requests
  FOR EACH ROW EXECUTE FUNCTION sync_studio_document_requests_to_documents();

-- ── Backfill one-time (idempotente, ON CONFLICT DO NOTHING) ─────────────────

INSERT INTO documents (
  company_id, owner_type, name, category, bucket, file_path,
  file_size, ai_summary, uploaded_by,
  source_table, legacy_id, created_at, updated_at
)
SELECT
  company_id, 'company', original_filename, document_type, 'site-documents', storage_path,
  file_size_bytes, summary, NULL,
  'ladia_document_templates', id, created_at, now()
FROM ladia_document_templates
ON CONFLICT (source_table, legacy_id) DO NOTHING;

INSERT INTO documents (
  company_id, owner_type, studio_id, name, category, bucket, file_path,
  file_size, mime_type, notes, uploaded_by,
  source_table, legacy_id, created_at, updated_at
)
SELECT
  company_id, 'company', studio_id, name, category, 'site-documents', file_path,
  file_size, mime_type, description, created_by,
  'studio_shared_documents', id, created_at, now()
FROM studio_shared_documents
ON CONFLICT (source_table, legacy_id) DO NOTHING;

INSERT INTO documents (
  company_id, owner_type, studio_id, name, category, notes, due_date,
  request_status, response_url, response_filename, response_notes,
  reviewer_notes, upload_token,
  source_table, legacy_id, created_at, updated_at
)
SELECT
  company_id, 'company', studio_id, title, document_type, description, due_date,
  status, response_url, response_filename, response_notes,
  reviewer_notes, upload_token,
  'studio_document_requests', id, created_at, COALESCE(updated_at, now())
FROM studio_document_requests
ON CONFLICT (source_table, legacy_id) DO NOTHING;
