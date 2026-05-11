-- Migration 064: PIMUS Documents
-- Piano di Montaggio, Uso e Smontaggio dei Ponteggi (D.Lgs 81/2008 Art. 136, Allegato XXII)
-- Pattern identico a dvr_documents / pos_documents

CREATE TABLE IF NOT EXISTS pimus_documents (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        REFERENCES companies(id) ON DELETE CASCADE,
  site_id     UUID        REFERENCES sites(id) ON DELETE SET NULL,
  revision    INTEGER     NOT NULL DEFAULT 1,
  content     TEXT,        -- contenuto AI generato (procedure, DPI, verifiche, emergenza)
  pimus_data  JSONB,       -- dati input form (ponteggio, addetti, figure, ecc.)
  created_by  UUID,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pimus_company
  ON pimus_documents(company_id, created_at DESC)
  WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pimus_site
  ON pimus_documents(site_id)
  WHERE site_id IS NOT NULL;

CREATE OR REPLACE FUNCTION _pimus_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER pimus_updated_at
  BEFORE UPDATE ON pimus_documents
  FOR EACH ROW EXECUTE FUNCTION _pimus_set_updated_at();

-- RLS: solo i membri della company
ALTER TABLE pimus_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY pimus_select ON pimus_documents FOR SELECT
  USING (is_company_member(company_id));
CREATE POLICY pimus_insert ON pimus_documents FOR INSERT
  WITH CHECK (is_company_member(company_id));
CREATE POLICY pimus_update ON pimus_documents FOR UPDATE
  USING (is_company_member(company_id));
CREATE POLICY pimus_delete ON pimus_documents FOR DELETE
  USING (is_company_member(company_id));
