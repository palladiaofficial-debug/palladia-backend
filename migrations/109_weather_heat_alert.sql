-- Migration 109: soglia ondata di calore + tabella throttle avvisi previsionale

-- Soglia temperatura massima per avviso caldo (0 = disabilitato)
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS weather_heat_c NUMERIC(4,1) DEFAULT 35 NOT NULL;

COMMENT ON COLUMN sites.weather_heat_c IS 'Soglia temperatura max (°C) per avviso ondata di calore (default 35, 0 = disabilitato)';

-- Tabella throttle: ogni (site, data_previsione, tipo) riceve al massimo un avviso
CREATE TABLE IF NOT EXISTS site_weather_alert_sent (
  id          bigserial   PRIMARY KEY,
  site_id     uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  company_id  uuid        NOT NULL,
  alert_date  date        NOT NULL,
  alert_type  text        NOT NULL CHECK (alert_type IN ('heat', 'snow', 'thunderstorm')),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, alert_date, alert_type)
);

CREATE INDEX IF NOT EXISTS site_weather_alert_sent_company_idx
  ON site_weather_alert_sent(company_id);

CREATE INDEX IF NOT EXISTS site_weather_alert_sent_site_date_idx
  ON site_weather_alert_sent(site_id, alert_date);

ALTER TABLE site_weather_alert_sent ENABLE ROW LEVEL SECURITY;
