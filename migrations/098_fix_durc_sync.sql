-- 098_fix_durc_sync.sql
-- Fix bug: il trigger sync_company_durc_expiry aggiornava solo durc_expiry_date
-- ma il codice backend usa companies.durc_expiry come colonna canonica.
-- Soluzione: il trigger aggiorna entrambe le colonne in sincronia.
-- Aggiunge anche la FK mancante su durc_records.studio_id.

-- Assicura che durc_expiry_date esista (migration 067 la crea, ma aggiungiamo IF NOT EXISTS)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS durc_expiry      DATE,
  ADD COLUMN IF NOT EXISTS durc_expiry_date DATE;

-- Sincronizza i valori esistenti divergenti: prende il MAX tra le due colonne
UPDATE companies
SET durc_expiry      = GREATEST(durc_expiry, durc_expiry_date),
    durc_expiry_date = GREATEST(durc_expiry, durc_expiry_date)
WHERE durc_expiry IS NOT NULL OR durc_expiry_date IS NOT NULL;

-- Sostituisce il trigger per aggiornare entrambe le colonne
CREATE OR REPLACE FUNCTION sync_company_durc_expiry()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  latest_expiry DATE;
BEGIN
  SELECT MAX(expiry_date) INTO latest_expiry
  FROM durc_records
  WHERE company_id = COALESCE(NEW.company_id, OLD.company_id);

  UPDATE companies
  SET durc_expiry      = latest_expiry,
      durc_expiry_date = latest_expiry
  WHERE id = COALESCE(NEW.company_id, OLD.company_id);

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_durc_expiry ON durc_records;
CREATE TRIGGER trg_sync_durc_expiry
AFTER INSERT OR DELETE ON durc_records
FOR EACH ROW EXECUTE FUNCTION sync_company_durc_expiry();

-- FK mancante su durc_records.studio_id → studio_partners
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'durc_records' AND constraint_name = 'durc_records_studio_id_fkey'
  ) THEN
    ALTER TABLE durc_records
      ADD CONSTRAINT durc_records_studio_id_fkey
      FOREIGN KEY (studio_id) REFERENCES studio_partners(id) ON DELETE SET NULL;
  END IF;
END;
$$;
