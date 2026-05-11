-- Migration 060: DVR Documents
-- Documenti di Valutazione dei Rischi generati con AI (D.Lgs 81/2008 Art. 28)
-- Pattern identico a pos_documents: salva solo content (sezione AI) + dvr_data (JSON input)
-- L'HTML viene rigenerato on-the-fly al download PDF

CREATE TABLE IF NOT EXISTS dvr_documents (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        REFERENCES companies(id) ON DELETE CASCADE,  -- nullable: come pos_documents
  site_id     UUID        REFERENCES sites(id) ON DELETE SET NULL,     -- opzionale: DVR può essere aziendale
  revision    INTEGER     NOT NULL DEFAULT 1,
  content     TEXT,        -- sezione "valutazione rischi per mansione" generata da AI (Haiku)
  dvr_data    JSONB,       -- dati input form (anagrafica, mansioni, figure sicurezza, ecc.)
  created_by  UUID,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dvr_documents_company
  ON dvr_documents(company_id, created_at DESC)
  WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dvr_documents_site
  ON dvr_documents(site_id)
  WHERE site_id IS NOT NULL;

-- Aggiorna updated_at automaticamente
CREATE OR REPLACE FUNCTION _dvr_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER dvr_updated_at
  BEFORE UPDATE ON dvr_documents
  FOR EACH ROW EXECUTE FUNCTION _dvr_set_updated_at();

-- RLS: solo i membri della company accedono ai propri DVR
ALTER TABLE dvr_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY dvr_select ON dvr_documents FOR SELECT
  USING (is_company_member(company_id));

CREATE POLICY dvr_insert ON dvr_documents FOR INSERT
  WITH CHECK (is_company_member(company_id));

CREATE POLICY dvr_update ON dvr_documents FOR UPDATE
  USING (is_company_member(company_id));

CREATE POLICY dvr_delete ON dvr_documents FOR DELETE
  USING (is_company_member(company_id));
