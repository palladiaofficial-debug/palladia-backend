-- 094_durc_records.sql
-- Storico DURC per impresa, gestito dallo studio CDL.
-- Ogni record = un DURC emesso; il più recente aggiorna automaticamente
-- companies.durc_expiry_date tramite trigger.

CREATE TABLE IF NOT EXISTS durc_records (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  studio_id       UUID        NOT NULL,
  issue_date      DATE        NOT NULL,
  expiry_date     DATE        NOT NULL,
  protocol_number VARCHAR(100),
  notes           TEXT,
  document_url    TEXT,
  created_by      UUID        REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_durc_records_company ON durc_records(company_id, expiry_date DESC);
CREATE INDEX IF NOT EXISTS idx_durc_records_studio  ON durc_records(studio_id);

-- Aggiorna companies.durc_expiry_date con la scadenza più recente dopo insert/delete
CREATE OR REPLACE FUNCTION sync_company_durc_expiry()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  latest_expiry DATE;
BEGIN
  SELECT MAX(expiry_date) INTO latest_expiry
  FROM durc_records
  WHERE company_id = COALESCE(NEW.company_id, OLD.company_id);

  UPDATE companies
  SET durc_expiry_date = latest_expiry
  WHERE id = COALESCE(NEW.company_id, OLD.company_id);

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_durc_expiry ON durc_records;
CREATE TRIGGER trg_sync_durc_expiry
AFTER INSERT OR DELETE ON durc_records
FOR EACH ROW EXECUTE FUNCTION sync_company_durc_expiry();
