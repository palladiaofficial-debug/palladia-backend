-- F-199 (AUDIT.md): "i giorni di pioggia non funzionano" — la fonte ERA5 è una
-- rianalisi su griglia, non la stazione a terra che INPS/CIGO riconoscono
-- (circolare INPS n. 139 del 01/08/2016, verificata sul PDF ufficiale ARPAL).
-- Aggiunge 'arpal_certified' come terzo data_source, con precedenza sempre
-- su 'era5_confirmed' — stesso principio di non-sovrascrittura di un giorno
-- già deciso da un umano già usato in migrations/197.

ALTER TABLE site_weather_logs
  DROP CONSTRAINT IF EXISTS site_weather_logs_data_source_check;

ALTER TABLE site_weather_logs
  ADD CONSTRAINT site_weather_logs_data_source_check
    CHECK (data_source IN ('forecast_preliminary', 'era5_confirmed', 'arpal_certified'));

ALTER TABLE site_weather_logs
  ADD COLUMN IF NOT EXISTS arpal_station_name TEXT,
  ADD COLUMN IF NOT EXISTS arpal_imported_at  TIMESTAMPTZ;

COMMENT ON COLUMN site_weather_logs.data_source IS
  'forecast_preliminary = stima Open-Meteo Forecast API (mai riverificata); era5_confirmed = riconciliato con Open-Meteo Archive/ERA5; arpal_certified = importato da CSV ufficiale ARPAL (stazione a terra, standard CIGO/INPS) — massima precedenza, mai sovrascritto da ERA5';
COMMENT ON COLUMN site_weather_logs.arpal_station_name IS
  'Nome stazione ARPAL da cui proviene precipitation_mm quando data_source = arpal_certified (es. "GENOVA - CENTRO FUNZIONALE")';
