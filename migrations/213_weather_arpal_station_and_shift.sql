-- F-199 (AUDIT.md): due richieste esplicite del titolare dopo aver visto il
-- fetch automatico ARPAL in produzione.
--
-- 1) "Assicurati che siano davvero dati ARPAL... spiega con un popup come
--    funziona l'estrazione" — serve sapere QUALE stazione un cantiere sta
--    usando anche prima che qualunque giorno sia stato certificato (il
--    popup deve poterlo mostrare subito, non solo dopo il primo giro del
--    cron). weatherArpalCron.js scrive qui la stazione risolta ad ogni
--    esecuzione riuscita.
--
-- 2) "La fascia oraria possa essere impostata, perché se lavoro di giorno
--    non mi interessa se piove la sera" — la precipitazione ARPAL cumulata
--    giornaliera non distingue le ore. weather_shift_enabled attiva il
--    fetch orario (Frequenza=HH) invece di quello giornaliero, sommando
--    solo le ore dentro [weather_shift_start, weather_shift_end) in ora
--    locale Europe/Rome (i dati ARPAL sono in UTC) — vedi lib/weatherShift.js.
--    Un turno che attraversa la mezzanotte (es. notte 20:00-06:00) è
--    supportato: le ore dopo mezzanotte contano per il giorno di INIZIO turno.

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS arpal_station_code        TEXT,
  ADD COLUMN IF NOT EXISTS arpal_station_name        TEXT,
  ADD COLUMN IF NOT EXISTS arpal_station_distance_m  INTEGER,
  ADD COLUMN IF NOT EXISTS arpal_last_checked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS weather_shift_enabled      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS weather_shift_start        TIME,
  ADD COLUMN IF NOT EXISTS weather_shift_end          TIME;

COMMENT ON COLUMN sites.arpal_station_code IS 'Codice stazione ARPAL risolta più di recente per questo cantiere (es. ME00041) — aggiornato da weatherArpalCron.js ad ogni esecuzione riuscita, mostrato nel popup "come funziona"';
COMMENT ON COLUMN sites.weather_shift_enabled IS 'Se true, la precipitazione conta solo le ore tra weather_shift_start e weather_shift_end (ora locale Europe/Rome) invece del totale giornaliero — richiede fetch ARPAL orario';
COMMENT ON COLUMN sites.weather_shift_start IS 'Inizio fascia oraria di lavoro (ora locale). Se > weather_shift_end, il turno attraversa la mezzanotte (es. 20:00-06:00 = notte)';

ALTER TABLE site_weather_logs
  ADD COLUMN IF NOT EXISTS precipitation_mm_full_day NUMERIC(6,2);

COMMENT ON COLUMN site_weather_logs.precipitation_mm_full_day IS 'Totale pioggia sulle 24h intere del giorno, popolato solo quando il cantiere ha weather_shift_enabled=true (precipitation_mm in quel caso è filtrato sulla sola fascia oraria di lavoro) — per audit/trasparenza, mai usato per il verdetto soglia';
