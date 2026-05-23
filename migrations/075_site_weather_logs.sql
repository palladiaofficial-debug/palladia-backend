-- Migration 075: Storico meteo giornaliero per cantiere
-- Popolato automaticamente dal cron alle 6:30 con dati reali Open-Meteo/ERA5.
-- È la fonte di verità per report legali e contrattuale.

CREATE TABLE IF NOT EXISTS site_weather_logs (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID        NOT NULL REFERENCES companies(id)   ON DELETE CASCADE,
  site_id                 UUID        NOT NULL REFERENCES sites(id)       ON DELETE CASCADE,
  log_date                DATE        NOT NULL,

  -- Dati meteo reali (ERA5 / Open-Meteo)
  precipitation_mm        NUMERIC(6,2) NOT NULL DEFAULT 0,
  wind_max_kmh            NUMERIC(5,1) NOT NULL DEFAULT 0,
  temp_min_c              NUMERIC(4,1),
  temp_max_c              NUMERIC(4,1),
  weather_code            INTEGER,
  weather_desc            TEXT,

  -- Soglie superate → suggerisce sospensione
  threshold_exceeded      BOOLEAN     NOT NULL DEFAULT false,
  threshold_reason        TEXT,       -- 'pioggia' | 'vento' | 'neve' | 'temporale'

  -- Gestione notifica / conferma
  suspension_confirmed    BOOLEAN     NOT NULL DEFAULT false,
  suspension_dismissed    BOOLEAN     NOT NULL DEFAULT false,
  suspension_id           UUID        REFERENCES site_suspension_days(id) ON DELETE SET NULL,

  fetched_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(site_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_swl_site    ON site_weather_logs(site_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_swl_company ON site_weather_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_swl_pending ON site_weather_logs(site_id)
  WHERE threshold_exceeded = true
    AND suspension_confirmed = false
    AND suspension_dismissed = false;
