-- Migration 069: Kit Baracca — checklist documenti per cantiere
CREATE TABLE IF NOT EXISTS site_baracca_checklist (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   UUID        NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  site_id      UUID        NOT NULL REFERENCES sites(id)      ON DELETE CASCADE,
  item_key     TEXT        NOT NULL,
  checked      BOOLEAN     NOT NULL DEFAULT FALSE,
  checked_at   TIMESTAMPTZ,
  checked_by   UUID        REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(site_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_baracca_site    ON site_baracca_checklist(site_id);
CREATE INDEX IF NOT EXISTS idx_baracca_company ON site_baracca_checklist(company_id);

ALTER TABLE site_baracca_checklist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "baracca_company_member"
  ON site_baracca_checklist FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));
