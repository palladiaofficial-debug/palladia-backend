-- Migration 038: configurazione Ladia per cantiere
-- Attivazione di Ladia In Cantiere per singolo sito (piano Grow+)

CREATE TABLE IF NOT EXISTS ladia_site_config (
  id               uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id       uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id          uuid        NOT NULL UNIQUE REFERENCES sites(id) ON DELETE CASCADE,
  is_active        boolean     NOT NULL DEFAULT false,
  briefing_time    time        NOT NULL DEFAULT '07:30',
  activated_at     timestamptz,
  activated_by     uuid,       -- user_id (auth.users)
  capitolato_summary text,     -- riassunto AI del capitolato (3-5 frasi, per briefing Telegram)
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ladia_site_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_members_ladia_config"
  ON ladia_site_config FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

CREATE INDEX IF NOT EXISTS idx_ladia_site_config_company
  ON ladia_site_config (company_id, is_active);

CREATE INDEX IF NOT EXISTS idx_ladia_site_config_site
  ON ladia_site_config (site_id);
