-- Migration 036 — User Site Assignments
--
-- Ogni utente di tipo tech/viewer può essere assegnato esplicitamente
-- a un sottoinsieme di cantieri della propria company.
-- Le notifiche Telegram (briefing, alert NC, uscite mancanti, ecc.)
-- vengono filtrate per mostrare solo i cantieri assegnati.
--
-- Regole:
--   owner / admin → nessun filtro, vedono sempre tutti i cantieri
--   tech / viewer → vedono solo i cantieri in questa tabella

CREATE TABLE IF NOT EXISTS user_site_assignments (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL,
  site_id    UUID        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_usa_company_user ON user_site_assignments(company_id, user_id);
CREATE INDEX IF NOT EXISTS idx_usa_site         ON user_site_assignments(site_id);

-- Nessuna RLS necessaria: gli insert/delete avvengono solo via service_role
-- (bot Telegram e backend API) mai direttamente dal client.
