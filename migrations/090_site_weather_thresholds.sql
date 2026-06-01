-- Migration 090: soglie meteo configurabili per cantiere
-- Valori di default = soglie storiche (backward-compatible)
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS weather_rain_mm      NUMERIC(5,1) DEFAULT 10   NOT NULL,
  ADD COLUMN IF NOT EXISTS weather_wind_kmh     NUMERIC(5,1) DEFAULT 50   NOT NULL,
  ADD COLUMN IF NOT EXISTS weather_snow         BOOLEAN      DEFAULT true  NOT NULL,
  ADD COLUMN IF NOT EXISTS weather_thunderstorm BOOLEAN      DEFAULT true  NOT NULL;

COMMENT ON COLUMN sites.weather_rain_mm      IS 'Soglia pioggia in mm/giorno per sospensione (default 10)';
COMMENT ON COLUMN sites.weather_wind_kmh     IS 'Soglia vento in km/h per sospensione (default 50)';
COMMENT ON COLUMN sites.weather_snow         IS 'Abilita sospensione per neve (WMO 71-86)';
COMMENT ON COLUMN sites.weather_thunderstorm IS 'Abilita sospensione per temporale (WMO >=95)';
