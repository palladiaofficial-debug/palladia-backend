-- F-159 (AUDIT.md): il cron giornaliero salva il meteo di "ieri" chiamando
-- SEMPRE la Forecast API di Open-Meteo (una stima) — mai l'Archive/ERA5,
-- perché a 1 giorno di distanza ERA5 non è ancora disponibile (5-10gg di
-- latenza). L'etichetta "confermato ERA5" che il frontend mostrava dopo 10
-- giorni era calcolata solo sull'età della data, MAI su una vera riverifica:
-- il numero restava la stima iniziale per sempre. Verificato dal vivo:
-- un giorno stimato 3,4mm/temporale non aveva mai avuto un vero temporale
-- (ERA5: 1,4mm/pioggerella); un giorno stimato 0,2mm (nessuna soglia
-- superata) aveva in realtà 2,6mm secondo ERA5 — un giorno di pioggia mai
-- segnalato.
--
-- Queste colonne supportano un cron di riconciliazione che, quando ERA5
-- diventa disponibile, aggiorna il dato grezzo con il valore confermato.
-- Decisione esplicita dell'utente: una decisione umana già presa
-- (suspension_confirmed o suspension_dismissed) non viene MAI toccata nel
-- verdetto (threshold_exceeded/reason) — ha conseguenze reali (operai
-- mandati a casa, comunicati già fatti) — ma il dato grezzo si aggiorna
-- comunque per l'accuratezza storica/export, con l'originale conservato per
-- audit e un flag se il nuovo dato avrebbe cambiato il verdetto.

ALTER TABLE site_weather_logs
  ADD COLUMN IF NOT EXISTS data_source TEXT NOT NULL DEFAULT 'forecast_preliminary'
    CHECK (data_source IN ('forecast_preliminary', 'era5_confirmed')),
  ADD COLUMN IF NOT EXISTS era5_reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS precipitation_mm_original NUMERIC,
  ADD COLUMN IF NOT EXISTS wind_max_kmh_original NUMERIC,
  ADD COLUMN IF NOT EXISTS weather_code_original INT,
  ADD COLUMN IF NOT EXISTS era5_discrepancy BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN site_weather_logs.data_source IS
  'forecast_preliminary = stima Open-Meteo Forecast API (mai riverificata); era5_confirmed = riconciliato con Open-Meteo Archive/ERA5';
COMMENT ON COLUMN site_weather_logs.era5_discrepancy IS
  'true se il dato ERA5 confermato avrebbe cambiato threshold_exceeded rispetto alla stima originale, ma il giorno era già stato deciso da un umano (verdetto mai alterato automaticamente)';
