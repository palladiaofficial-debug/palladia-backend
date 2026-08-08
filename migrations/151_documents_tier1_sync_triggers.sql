-- 151_documents_tier1_sync_triggers.sql
-- Fase 2, Scaglione 1 — passo "sync". Trigger AFTER INSERT/UPDATE/DELETE sulle
-- 4 tabelle storiche che replicano ogni scrittura in `documents`.
--
-- Vincolo esplicito dell'utente: un trigger di sincronizzazione non deve MAI
-- poter far fallire la scrittura sulla tabella storica. Ogni funzione avvolge
-- la propria logica in un blocco EXCEPTION WHEN OTHERS — se la sync fallisce,
-- l'errore viene loggato in document_sync_failures e la funzione ritorna
-- normalmente; anche il logging stesso è avvolto in un secondo blocco, così
-- un fallimento nel fallback di logging non può propagare a sua volta.
-- Il codice applicativo (incluso routes/v1/chat.js, congelato) non cambia:
-- continua a scrivere sulle tabelle storiche esattamente come prima.

-- ── site_documents ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_site_documents_to_documents() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM documents WHERE source_table = 'site_documents' AND legacy_id = OLD.id;
    ELSE
      INSERT INTO documents (
        company_id, owner_type, site_id, name, category, bucket, file_path,
        file_size, mime_type, ai_expiry_date, ai_summary, ai_renewal_years,
        ai_issued_by, ai_issues, ai_validity_ok, ai_analyzed_at, content_hash,
        uploaded_by, source_table, legacy_id, created_at, updated_at
      ) VALUES (
        NEW.company_id, 'site', NEW.site_id, NEW.name, NEW.category, 'site-documents', NEW.file_path,
        NEW.file_size, NEW.mime_type, NEW.ai_expiry_date, NEW.ai_summary, NEW.ai_renewal_years,
        NEW.ai_issued_by, NEW.ai_issues, NEW.ai_validity_ok, NEW.ai_analyzed_at, NEW.content_hash,
        NEW.uploaded_by, 'site_documents', NEW.id, NEW.created_at, now()
      )
      ON CONFLICT (source_table, legacy_id) DO UPDATE SET
        company_id = EXCLUDED.company_id, site_id = EXCLUDED.site_id, name = EXCLUDED.name,
        category = EXCLUDED.category, file_path = EXCLUDED.file_path, file_size = EXCLUDED.file_size,
        mime_type = EXCLUDED.mime_type, ai_expiry_date = EXCLUDED.ai_expiry_date,
        ai_summary = EXCLUDED.ai_summary, ai_renewal_years = EXCLUDED.ai_renewal_years,
        ai_issued_by = EXCLUDED.ai_issued_by, ai_issues = EXCLUDED.ai_issues,
        ai_validity_ok = EXCLUDED.ai_validity_ok, ai_analyzed_at = EXCLUDED.ai_analyzed_at,
        content_hash = EXCLUDED.content_hash, uploaded_by = EXCLUDED.uploaded_by, updated_at = now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO document_sync_failures (source_table, legacy_id, operation, error_message)
      VALUES ('site_documents', COALESCE(NEW.id, OLD.id), TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_site_documents ON site_documents;
CREATE TRIGGER trg_sync_site_documents
  AFTER INSERT OR UPDATE OR DELETE ON site_documents
  FOR EACH ROW EXECUTE FUNCTION sync_site_documents_to_documents();

-- ── company_documents ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_company_documents_to_documents() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM documents WHERE source_table = 'company_documents' AND legacy_id = OLD.id;
    ELSE
      INSERT INTO documents (
        company_id, owner_type, name, category, bucket, file_path,
        file_size, mime_type, ai_expiry_date, ai_summary, ai_renewal_years,
        ai_issued_by, ai_issues, ai_validity_ok, ai_analyzed_at, content_hash,
        uploaded_by, source_table, legacy_id, created_at, updated_at
      ) VALUES (
        NEW.company_id, 'company', NEW.name, NEW.category, 'site-documents', NEW.file_path,
        NEW.file_size, NEW.mime_type, NEW.ai_expiry_date, NEW.ai_summary, NEW.ai_renewal_years,
        NEW.ai_issued_by, NEW.ai_issues, NEW.ai_validity_ok, NEW.ai_analyzed_at, NEW.content_hash,
        NEW.uploaded_by, 'company_documents', NEW.id, NEW.created_at, now()
      )
      ON CONFLICT (source_table, legacy_id) DO UPDATE SET
        company_id = EXCLUDED.company_id, name = EXCLUDED.name, category = EXCLUDED.category,
        file_path = EXCLUDED.file_path, file_size = EXCLUDED.file_size, mime_type = EXCLUDED.mime_type,
        ai_expiry_date = EXCLUDED.ai_expiry_date, ai_summary = EXCLUDED.ai_summary,
        ai_renewal_years = EXCLUDED.ai_renewal_years, ai_issued_by = EXCLUDED.ai_issued_by,
        ai_issues = EXCLUDED.ai_issues, ai_validity_ok = EXCLUDED.ai_validity_ok,
        ai_analyzed_at = EXCLUDED.ai_analyzed_at, content_hash = EXCLUDED.content_hash,
        uploaded_by = EXCLUDED.uploaded_by, updated_at = now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO document_sync_failures (source_table, legacy_id, operation, error_message)
      VALUES ('company_documents', COALESCE(NEW.id, OLD.id), TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_company_documents ON company_documents;
CREATE TRIGGER trg_sync_company_documents
  AFTER INSERT OR UPDATE OR DELETE ON company_documents
  FOR EACH ROW EXECUTE FUNCTION sync_company_documents_to_documents();

-- ── worker_documents ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_worker_documents_to_documents() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM documents WHERE source_table = 'worker_documents' AND legacy_id = OLD.id;
    ELSE
      INSERT INTO documents (
        company_id, owner_type, worker_id, name, category, bucket, file_path,
        mime_type, issued_date, expiry_date, ai_expiry_date, ai_summary, ai_renewal_years,
        ai_issued_by, ai_issued_to, ai_issues, ai_validity_ok, ai_analyzed_at, content_hash,
        notes, source_table, legacy_id, created_at, updated_at
      ) VALUES (
        NEW.company_id, 'worker', NEW.worker_id, NEW.name, NEW.doc_type, 'site-documents',
        COALESCE(NEW.file_path, (SELECT object_path FROM extract_storage_ref(NEW.file_url))),
        NEW.mime_type, NEW.issued_date, NEW.expiry_date, NEW.ai_expiry_date, NEW.ai_summary, NEW.ai_renewal_years,
        NEW.ai_issued_by, NEW.ai_issued_to, NEW.ai_issues, NEW.ai_validity_ok, NEW.ai_analyzed_at, NEW.content_hash,
        NEW.notes, 'worker_documents', NEW.id, NEW.created_at, COALESCE(NEW.updated_at, now())
      )
      ON CONFLICT (source_table, legacy_id) DO UPDATE SET
        company_id = EXCLUDED.company_id, worker_id = EXCLUDED.worker_id, name = EXCLUDED.name,
        category = EXCLUDED.category, file_path = EXCLUDED.file_path, mime_type = EXCLUDED.mime_type,
        issued_date = EXCLUDED.issued_date, expiry_date = EXCLUDED.expiry_date,
        ai_expiry_date = EXCLUDED.ai_expiry_date, ai_summary = EXCLUDED.ai_summary,
        ai_renewal_years = EXCLUDED.ai_renewal_years, ai_issued_by = EXCLUDED.ai_issued_by,
        ai_issued_to = EXCLUDED.ai_issued_to, ai_issues = EXCLUDED.ai_issues,
        ai_validity_ok = EXCLUDED.ai_validity_ok, ai_analyzed_at = EXCLUDED.ai_analyzed_at,
        content_hash = EXCLUDED.content_hash, notes = EXCLUDED.notes, updated_at = now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO document_sync_failures (source_table, legacy_id, operation, error_message)
      VALUES ('worker_documents', COALESCE(NEW.id, OLD.id), TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_worker_documents ON worker_documents;
CREATE TRIGGER trg_sync_worker_documents
  AFTER INSERT OR UPDATE OR DELETE ON worker_documents
  FOR EACH ROW EXECUTE FUNCTION sync_worker_documents_to_documents();

-- ── worker_certificates ──────────────────────────────────────────────────────
-- pdf_url è storicamente incoerente: a volte un path raw, a volte una signed
-- URL sul bucket site-documents, a volte sul bucket documents (verificato dal
-- vivo su dati reali, F-037). extract_storage_ref normalizza; se non riesce a
-- riconoscere il pattern, il path viene comunque preservato as-is e la riga è
-- marcata file_path_needs_review per non perdere il riferimento silenziosamente.
CREATE OR REPLACE FUNCTION sync_worker_certificates_to_documents() RETURNS TRIGGER AS $$
DECLARE
  ref RECORD;
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM documents WHERE source_table = 'worker_certificates' AND legacy_id = OLD.id;
    ELSE
      SELECT * INTO ref FROM extract_storage_ref(NEW.pdf_url);
      INSERT INTO documents (
        company_id, owner_type, worker_id, site_id, category, bucket, file_path, file_path_needs_review,
        issued_date, expiry_date, content_hash, course_type_id, certificate_number, issuing_body,
        deleted_at, source_table, legacy_id, created_at, updated_at
      ) VALUES (
        NEW.company_id, 'worker', NEW.worker_id, NEW.site_id, 'certificato_formazione',
        COALESCE(ref.bucket, 'site-documents'),
        COALESCE(ref.object_path, NEW.pdf_url),
        (NEW.pdf_url IS NOT NULL AND ref.object_path IS NULL),
        NEW.issue_date, NEW.expiry_date, NEW.content_hash, NEW.course_type_id, NEW.certificate_number, NEW.issuing_body,
        NEW.deleted_at, 'worker_certificates', NEW.id, NEW.created_at, now()
      )
      ON CONFLICT (source_table, legacy_id) DO UPDATE SET
        company_id = EXCLUDED.company_id, worker_id = EXCLUDED.worker_id, site_id = EXCLUDED.site_id,
        bucket = EXCLUDED.bucket, file_path = EXCLUDED.file_path,
        file_path_needs_review = EXCLUDED.file_path_needs_review,
        issued_date = EXCLUDED.issued_date, expiry_date = EXCLUDED.expiry_date,
        content_hash = EXCLUDED.content_hash, course_type_id = EXCLUDED.course_type_id,
        certificate_number = EXCLUDED.certificate_number, issuing_body = EXCLUDED.issuing_body,
        deleted_at = EXCLUDED.deleted_at, updated_at = now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO document_sync_failures (source_table, legacy_id, operation, error_message)
      VALUES ('worker_certificates', COALESCE(NEW.id, OLD.id), TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_worker_certificates ON worker_certificates;
CREATE TRIGGER trg_sync_worker_certificates
  AFTER INSERT OR UPDATE OR DELETE ON worker_certificates
  FOR EACH ROW EXECUTE FUNCTION sync_worker_certificates_to_documents();

-- ── Backfill one-time delle righe già esistenti ──────────────────────────────
-- Idempotente (ON CONFLICT DO NOTHING) — sicuro da rieseguire.

INSERT INTO documents (
  company_id, owner_type, site_id, name, category, bucket, file_path,
  file_size, mime_type, ai_expiry_date, ai_summary, ai_renewal_years,
  ai_issued_by, ai_issues, ai_validity_ok, ai_analyzed_at, content_hash,
  uploaded_by, source_table, legacy_id, created_at, updated_at
)
SELECT
  company_id, 'site', site_id, name, category, 'site-documents', file_path,
  file_size, mime_type, ai_expiry_date, ai_summary, ai_renewal_years,
  ai_issued_by, ai_issues, ai_validity_ok, ai_analyzed_at, content_hash,
  uploaded_by, 'site_documents', id, created_at, now()
FROM site_documents
ON CONFLICT (source_table, legacy_id) DO NOTHING;

INSERT INTO documents (
  company_id, owner_type, name, category, bucket, file_path,
  file_size, mime_type, ai_expiry_date, ai_summary, ai_renewal_years,
  ai_issued_by, ai_issues, ai_validity_ok, ai_analyzed_at, content_hash,
  uploaded_by, source_table, legacy_id, created_at, updated_at
)
SELECT
  company_id, 'company', name, category, 'site-documents', file_path,
  file_size, mime_type, ai_expiry_date, ai_summary, ai_renewal_years,
  ai_issued_by, ai_issues, ai_validity_ok, ai_analyzed_at, content_hash,
  uploaded_by, 'company_documents', id, created_at, now()
FROM company_documents
ON CONFLICT (source_table, legacy_id) DO NOTHING;

INSERT INTO documents (
  company_id, owner_type, worker_id, name, category, bucket, file_path,
  mime_type, issued_date, expiry_date, ai_expiry_date, ai_summary, ai_renewal_years,
  ai_issued_by, ai_issued_to, ai_issues, ai_validity_ok, ai_analyzed_at, content_hash,
  notes, source_table, legacy_id, created_at, updated_at
)
SELECT
  wd.company_id, 'worker', wd.worker_id, wd.name, wd.doc_type, 'site-documents',
  COALESCE(wd.file_path, (SELECT object_path FROM extract_storage_ref(wd.file_url))),
  wd.mime_type, wd.issued_date, wd.expiry_date, wd.ai_expiry_date, wd.ai_summary, wd.ai_renewal_years,
  wd.ai_issued_by, wd.ai_issued_to, wd.ai_issues, wd.ai_validity_ok, wd.ai_analyzed_at, wd.content_hash,
  wd.notes, 'worker_documents', wd.id, wd.created_at, COALESCE(wd.updated_at, now())
FROM worker_documents wd
ON CONFLICT (source_table, legacy_id) DO NOTHING;

INSERT INTO documents (
  company_id, owner_type, worker_id, site_id, category, bucket, file_path, file_path_needs_review,
  issued_date, expiry_date, content_hash, course_type_id, certificate_number, issuing_body,
  deleted_at, source_table, legacy_id, created_at, updated_at
)
SELECT
  wc.company_id, 'worker', wc.worker_id, wc.site_id, 'certificato_formazione',
  COALESCE(ref.bucket, 'site-documents'),
  COALESCE(ref.object_path, wc.pdf_url),
  (wc.pdf_url IS NOT NULL AND ref.object_path IS NULL),
  wc.issue_date, wc.expiry_date, wc.content_hash, wc.course_type_id, wc.certificate_number, wc.issuing_body,
  wc.deleted_at, 'worker_certificates', wc.id, wc.created_at, now()
FROM worker_certificates wc
LEFT JOIN LATERAL extract_storage_ref(wc.pdf_url) ref ON true
ON CONFLICT (source_table, legacy_id) DO NOTHING;
