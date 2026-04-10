-- Migration 037: tabella equipment (mezzi e attrezzature aziendali)
-- Sostituisce il localStorage frontend con dati persistenti nel DB.

CREATE TABLE IF NOT EXISTS equipment (
  id               uuid         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id       uuid         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type             text         NOT NULL,
  model            text,
  plate_or_serial  text,
  ownership        text         NOT NULL DEFAULT 'Aziendale',
  purchase_date    date,
  inspection_date  date,
  insurance_expiry date,
  maintenance_date date,
  notes            text,
  is_active        boolean      NOT NULL DEFAULT true,
  created_at       timestamptz  NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE equipment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_members_equipment"
  ON equipment FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

-- Index per query frequenti
CREATE INDEX IF NOT EXISTS idx_equipment_company ON equipment (company_id) WHERE is_active = true;
