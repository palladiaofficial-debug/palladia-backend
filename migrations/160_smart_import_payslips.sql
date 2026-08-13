-- 160_smart_import_payslips.sql
-- Importazione Intelligente: le buste paga (doc_type=busta_paga, già
-- riconosciuto dalla classificazione AI, vedi services/smartImportAI.js) non
-- avevano una destinazione dedicata — finivano in worker_documents generico,
-- senza period_year/period_month/status, quindi invisibili nella lista buste
-- paga del lavoratore (routes/v1/workerArea.js legge SOLO dalla tabella
-- payslips). Aggiunge 'payslips' come destinazione valida per import_items,
-- e content_hash a payslips per il dedup contro re-import dello stesso file
-- (stesso pattern già usato per site_documents/company_documents/
-- worker_documents/worker_certificates in migrazione 136).

-- Il CHECK originale su import_items.destination era inline/senza nome
-- esplicito (migrazione 136) — lo cerchiamo dinamicamente invece di
-- assumere il nome auto-generato da Postgres, per non rischiare un DROP
-- CONSTRAINT silenzioso su un nome sbagliato che lascerebbe il vincolo
-- vecchio (4 valori) ancora attivo insieme al nuovo.
DO $$
DECLARE
  c text;
BEGIN
  SELECT conname INTO c
  FROM pg_constraint
  WHERE conrelid = 'import_items'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%destination%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE import_items DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE import_items ADD CONSTRAINT import_items_destination_check
  CHECK (destination IN ('site_documents', 'company_documents', 'worker_documents', 'worker_certificates', 'payslips'));

ALTER TABLE payslips ADD COLUMN IF NOT EXISTS content_hash text;
CREATE INDEX IF NOT EXISTS idx_payslips_hash ON payslips (company_id, content_hash);
