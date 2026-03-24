-- Migration 017: subcontractors table
-- Imprese subappaltatrici per azienda, con scadenze documenti e stato compliance

CREATE TABLE IF NOT EXISTS subcontractors (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  company_name     text        NOT NULL CHECK (length(trim(company_name)) > 0),
  piva             text,
  legal_address    text,
  contact_person   text,
  phone            text,
  email            text,
  durc_expiry      date,
  visura_date      date,
  insurance_expiry date,
  soa_expiry       date,
  f24_quarter      text,
  notify_expiry    boolean     NOT NULL DEFAULT true,
  is_active        boolean     NOT NULL DEFAULT true,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subcontractors_company ON subcontractors(company_id);
CREATE INDEX IF NOT EXISTS idx_subcontractors_company_active ON subcontractors(company_id, is_active);

-- Trigger: aggiorna updated_at automaticamente
CREATE OR REPLACE FUNCTION _subcontractors_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_subcontractors_updated_at ON subcontractors;
CREATE TRIGGER trg_subcontractors_updated_at
  BEFORE UPDATE ON subcontractors
  FOR EACH ROW EXECUTE FUNCTION _subcontractors_set_updated_at();
