-- Migration 074: Giorni di sospensione cantiere (pioggia, vento, neve, ecc.)
-- Ogni riga = una giornata in cui il cantiere non ha lavorato
-- L'aggiunta/rimozione di righe trigghera il ricalcolo di sites.end_date

CREATE TABLE IF NOT EXISTS site_suspension_days (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id    UUID        NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
  day        DATE        NOT NULL,
  reason     TEXT        NOT NULL DEFAULT 'pioggia',   -- pioggia | vento | neve | altro
  notes      TEXT,
  created_by UUID,                                     -- auth.users.id di chi ha segnato
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(site_id, day)
);

CREATE INDEX IF NOT EXISTS idx_ssd_site    ON site_suspension_days(site_id);
CREATE INDEX IF NOT EXISTS idx_ssd_company ON site_suspension_days(company_id);
CREATE INDEX IF NOT EXISTS idx_ssd_day     ON site_suspension_days(site_id, day DESC);
