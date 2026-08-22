-- 173_documents_tier4_sync_triggers.sql
-- Fase 2, Scaglione 4 — passo "sync". Stesso identico pattern degli scaglioni
-- precedenti (migrazioni 151/154/157): trigger AFTER INSERT/UPDATE/DELETE,
-- funzione avvolta in EXCEPTION WHEN OTHERS a due livelli, backfill idempotente
-- con source_table/legacy_id.
--
-- equipment_documents non ha una scadenza per-documento in colonna (solo
-- equipment.insurance_expiry a livello mezzo) — il dato utile vive dentro
-- ai_extracted (jsonb, popolato dall'OCR di routes/v1/equipment.js). Il CASE
-- sotto estrae la data giusta in base al doc_type: 'assicurazione' guarda
-- data_scadenza_assicurazione, 'revisione' guarda data_prossima_revisione. Un
-- valore malformato nell'estrazione AI fa fallire SOLO il cast (catturato dal
-- blocco EXCEPTION esterno, come ogni altro errore imprevisto qui) — la riga
-- storica non ne risente mai.

CREATE OR REPLACE FUNCTION sync_equipment_documents_to_documents() RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM documents WHERE source_table = 'equipment_documents' AND legacy_id = OLD.id;
    ELSE
      INSERT INTO documents (
        company_id, owner_type, equipment_id, name, category, bucket, file_path,
        file_size, mime_type, expiry_date, ai_summary, uploaded_by,
        source_table, legacy_id, created_at, updated_at
      ) VALUES (
        NEW.company_id, 'equipment', NEW.equipment_id, NEW.file_name, NEW.doc_type, 'equipment-docs', NEW.file_url,
        NEW.file_size, NEW.mime_type,
        CASE
          WHEN NEW.doc_type = 'assicurazione' AND (NEW.ai_extracted->>'data_scadenza_assicurazione') ~ '^\d{4}-\d{2}-\d{2}$'
            THEN (NEW.ai_extracted->>'data_scadenza_assicurazione')::date
          WHEN NEW.doc_type = 'revisione' AND (NEW.ai_extracted->>'data_prossima_revisione') ~ '^\d{4}-\d{2}-\d{2}$'
            THEN (NEW.ai_extracted->>'data_prossima_revisione')::date
          ELSE NULL
        END,
        NEW.ai_extracted->>'note_extra', NEW.uploaded_by,
        'equipment_documents', NEW.id, COALESCE(NEW.uploaded_at, now()), now()
      )
      ON CONFLICT (source_table, legacy_id) DO UPDATE SET
        company_id = EXCLUDED.company_id, equipment_id = EXCLUDED.equipment_id,
        name = EXCLUDED.name, category = EXCLUDED.category, file_path = EXCLUDED.file_path,
        file_size = EXCLUDED.file_size, mime_type = EXCLUDED.mime_type, expiry_date = EXCLUDED.expiry_date,
        ai_summary = EXCLUDED.ai_summary, uploaded_by = EXCLUDED.uploaded_by, updated_at = now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO document_sync_failures (source_table, legacy_id, operation, error_message)
      VALUES ('equipment_documents', COALESCE(NEW.id, OLD.id), TG_OP, SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_equipment_documents ON equipment_documents;
CREATE TRIGGER trg_sync_equipment_documents
  AFTER INSERT OR UPDATE OR DELETE ON equipment_documents
  FOR EACH ROW EXECUTE FUNCTION sync_equipment_documents_to_documents();

-- ── Backfill one-time (idempotente, ON CONFLICT DO NOTHING) ─────────────────
INSERT INTO documents (
  company_id, owner_type, equipment_id, name, category, bucket, file_path,
  file_size, mime_type, expiry_date, ai_summary, uploaded_by,
  source_table, legacy_id, created_at, updated_at
)
SELECT
  company_id, 'equipment', equipment_id, file_name, doc_type, 'equipment-docs', file_url,
  file_size, mime_type,
  CASE
    WHEN doc_type = 'assicurazione' AND (ai_extracted->>'data_scadenza_assicurazione') ~ '^\d{4}-\d{2}-\d{2}$'
      THEN (ai_extracted->>'data_scadenza_assicurazione')::date
    WHEN doc_type = 'revisione' AND (ai_extracted->>'data_prossima_revisione') ~ '^\d{4}-\d{2}-\d{2}$'
      THEN (ai_extracted->>'data_prossima_revisione')::date
    ELSE NULL
  END,
  ai_extracted->>'note_extra', uploaded_by,
  'equipment_documents', id, COALESCE(uploaded_at, now()), now()
FROM equipment_documents
ON CONFLICT (source_table, legacy_id) DO NOTHING;
