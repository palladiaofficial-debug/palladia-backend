-- 154_documents_tier2_sync_triggers.sql
-- Fase 2, Scaglione 2 — passo "sync". Stesso identico pattern dello
-- Scaglione 1 (migrazione 151): trigger AFTER INSERT/UPDATE/DELETE, ogni
-- funzione avvolta in EXCEPTION WHEN OTHERS a due livelli (la sync non può
-- MAI far fallire la scrittura storica, nemmeno se il logging del fallimento
-- stesso fallisce), backfill idempotente con source_table/legacy_id.

-- ── subcontractor_documents ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_subcontractor_documents_to_documents() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM documents WHERE source_table = 'subcontractor_documents' AND legacy_id = OLD.id;
    ELSE
      INSERT INTO documents (
        company_id, owner_type, subcontractor_id, name, category, bucket, file_path,
        file_size, mime_type, expiry_date, ai_expiry_date, ai_summary, ai_issues,
        ai_validity_ok, ai_analyzed_at, content_hash, uploaded_by,
        source_table, legacy_id, created_at, updated_at
      ) VALUES (
        NEW.company_id, 'subcontractor', NEW.subcontractor_id, NEW.name, NEW.category, 'site-documents', NEW.file_path,
        NEW.file_size, NEW.mime_type, NEW.valid_until, NEW.ai_expiry_date, NEW.ai_summary, NEW.ai_issues,
        NEW.ai_validity_ok, NEW.ai_analyzed_at, NEW.content_hash, NEW.uploaded_by,
        'subcontractor_documents', NEW.id, NEW.created_at, now()
      )
      ON CONFLICT (source_table, legacy_id) DO UPDATE SET
        company_id = EXCLUDED.company_id, subcontractor_id = EXCLUDED.subcontractor_id,
        name = EXCLUDED.name, category = EXCLUDED.category, file_path = EXCLUDED.file_path,
        file_size = EXCLUDED.file_size, mime_type = EXCLUDED.mime_type, expiry_date = EXCLUDED.expiry_date,
        ai_expiry_date = EXCLUDED.ai_expiry_date, ai_summary = EXCLUDED.ai_summary,
        ai_issues = EXCLUDED.ai_issues, ai_validity_ok = EXCLUDED.ai_validity_ok,
        ai_analyzed_at = EXCLUDED.ai_analyzed_at, content_hash = EXCLUDED.content_hash,
        uploaded_by = EXCLUDED.uploaded_by, updated_at = now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO document_sync_failures (source_table, legacy_id, operation, error_message)
      VALUES ('subcontractor_documents', COALESCE(NEW.id, OLD.id), TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_subcontractor_documents ON subcontractor_documents;
CREATE TRIGGER trg_sync_subcontractor_documents
  AFTER INSERT OR UPDATE OR DELETE ON subcontractor_documents
  FOR EACH ROW EXECUTE FUNCTION sync_subcontractor_documents_to_documents();

-- ── payslips ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_payslips_to_documents() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM documents WHERE source_table = 'payslips' AND legacy_id = OLD.id;
    ELSE
      INSERT INTO documents (
        company_id, owner_type, worker_id, studio_id, name, category, bucket, file_path,
        file_size, period_year, period_month, payslip_status, shared_at, acknowledged_at,
        notes, uploaded_by, source_table, legacy_id, created_at, updated_at
      ) VALUES (
        NEW.company_id, 'worker', NEW.worker_id, NEW.studio_id, NEW.filename, 'busta_paga', 'site-documents', NEW.file_path,
        NEW.file_size, NEW.period_year, NEW.period_month, NEW.status, NEW.shared_at, NEW.acknowledged_at,
        NEW.note, NEW.uploaded_by, 'payslips', NEW.id, NEW.created_at, COALESCE(NEW.updated_at, now())
      )
      ON CONFLICT (source_table, legacy_id) DO UPDATE SET
        company_id = EXCLUDED.company_id, worker_id = EXCLUDED.worker_id, studio_id = EXCLUDED.studio_id,
        name = EXCLUDED.name, file_path = EXCLUDED.file_path, file_size = EXCLUDED.file_size,
        period_year = EXCLUDED.period_year, period_month = EXCLUDED.period_month,
        payslip_status = EXCLUDED.payslip_status, shared_at = EXCLUDED.shared_at,
        acknowledged_at = EXCLUDED.acknowledged_at, notes = EXCLUDED.notes,
        uploaded_by = EXCLUDED.uploaded_by, updated_at = now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO document_sync_failures (source_table, legacy_id, operation, error_message)
      VALUES ('payslips', COALESCE(NEW.id, OLD.id), TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_payslips ON payslips;
CREATE TRIGGER trg_sync_payslips
  AFTER INSERT OR UPDATE OR DELETE ON payslips
  FOR EACH ROW EXECUTE FUNCTION sync_payslips_to_documents();

-- ── Backfill one-time (idempotente, ON CONFLICT DO NOTHING) ─────────────────

INSERT INTO documents (
  company_id, owner_type, subcontractor_id, name, category, bucket, file_path,
  file_size, mime_type, expiry_date, ai_expiry_date, ai_summary, ai_issues,
  ai_validity_ok, ai_analyzed_at, content_hash, uploaded_by,
  source_table, legacy_id, created_at, updated_at
)
SELECT
  company_id, 'subcontractor', subcontractor_id, name, category, 'site-documents', file_path,
  file_size, mime_type, valid_until, ai_expiry_date, ai_summary, ai_issues,
  ai_validity_ok, ai_analyzed_at, content_hash, uploaded_by,
  'subcontractor_documents', id, created_at, now()
FROM subcontractor_documents
ON CONFLICT (source_table, legacy_id) DO NOTHING;

INSERT INTO documents (
  company_id, owner_type, worker_id, studio_id, name, category, bucket, file_path,
  file_size, period_year, period_month, payslip_status, shared_at, acknowledged_at,
  notes, uploaded_by, source_table, legacy_id, created_at, updated_at
)
SELECT
  company_id, 'worker', worker_id, studio_id, filename, 'busta_paga', 'site-documents', file_path,
  file_size, period_year, period_month, status, shared_at, acknowledged_at,
  note, uploaded_by, 'payslips', id, created_at, COALESCE(updated_at, now())
FROM payslips
ON CONFLICT (source_table, legacy_id) DO NOTHING;
