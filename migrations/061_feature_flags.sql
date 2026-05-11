-- Migration 061: Feature Flags per company
-- Permette di nascondere moduli (computo, capitolato) a specifici clienti.
-- La logica di default si gestisce lato backend via env var.
-- Se manca una riga per (company_id, feature) → si usa il default da env.

CREATE TABLE IF NOT EXISTS company_feature_flags (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature     TEXT        NOT NULL,   -- 'computo' | 'capitolato' | 'dvr' | 'subcontractors_enterprise'
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  updated_by  UUID,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, feature)
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_company
  ON company_feature_flags(company_id);

-- RLS: i membri possono SOLO leggere i propri flag; la scrittura è service_role only
ALTER TABLE company_feature_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY feature_flags_select ON company_feature_flags FOR SELECT
  USING (is_company_member(company_id));
