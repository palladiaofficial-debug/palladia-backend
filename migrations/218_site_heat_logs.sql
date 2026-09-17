-- Registro caldo cantiere — richiesta esplicita del titolare (2026-09-17):
-- "serve poter calcolare con il massimo dettaglio e verità legale i giorni
-- di caldo... deve essere chirurgico".
--
-- Base normativa verificata (non "bollino rosso" — non è più il criterio
-- corretto): D.L. 26/06/2026 n. 107 art. 6 + messaggio INPS n. 2418 del
-- 20/07/2026, sospensioni 1/7-31/12/2026, imprese edili/lapideo/escavazione.
-- La norma non fissa una soglia automatica: richiede una RELAZIONE TECNICA
-- che documenti temperatura effettiva, umidità relativa, irraggiamento
-- solare, tipo di lavorazione, DPI, sforzo fisico — 35°C è solo "soglia
-- orientativa", non un interruttore automatico. Fonti dati accettate:
-- dipartimenti meteoclimatici (ARPAL), Protezione Civile, o Worklimate
-- (INAIL-CNR, indice WBGT) — Worklimate verificato (2026-09-17): SOLO
-- previsioni a 3-5 giorni, nessun dato storico, nessuna API pubblica —
-- inutilizzabile per certificare un giorno già trascorso.
--
-- Tabella SEPARATA da site_weather_logs (non un'estensione): il caldo è
-- una base normativa diversa dalla pioggia/vento (circolare INPS
-- 139/2016), confermata da un flusso distinto — mescolare le due
-- confonderebbe "perché" un giorno risulta sospeso in una relazione
-- tecnica che deve essere inequivocabile.
--
-- Tre grandezze CERTIFICATE dalla stessa stazione ARPAL già in uso per la
-- pioggia (verificato dal vivo, 2026-09-17, stazione GENOVA - CENTRO
-- FUNZIONALE, dati reali agosto 2026):
--   TEMPTRMWC4  Temperatura massima assoluta dell'aria (°C)
--   UMREIGRWCL  Umidità relativa media dell'aria (%)
--   RSTORDTWCL  Radiazione solare giornaliera (J/cm²)
-- wbgt_estimate_c è un valore CALCOLATO da temperatura+umidità con la
-- formula semplificata pubblica del Bureau of Meteorology australiano
-- (vedi lib/heatIndex.js) — una STIMA utile come elemento della relazione
-- tecnica, mai spacciata per il WBGT ISO 7243 reale (che richiede un
-- termometro a globo nero, non misurabile da una stazione meteo standard).

CREATE TABLE IF NOT EXISTS site_heat_logs (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id                   uuid        NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
  log_date                  date        NOT NULL,

  temp_max_c                numeric,
  humidity_pct              numeric,
  solar_radiation_jcm2      numeric,
  wbgt_estimate_c           numeric,

  threshold_exceeded        boolean     NOT NULL DEFAULT false,
  threshold_reason          text,   -- es. 'temperatura', 'wbgt_stimato'

  suspension_confirmed      boolean     NOT NULL DEFAULT false,
  suspension_dismissed      boolean     NOT NULL DEFAULT false,
  suspension_id             uuid,   -- riferimento libero, stesso pattern di site_weather_logs

  data_source                text        NOT NULL DEFAULT 'arpal_certified' CHECK (data_source = 'arpal_certified'),
  arpal_station_name         text,
  arpal_source_path          text,   -- CSV originale archiviato, stesso bucket/meccanismo di F-207
  fetched_at                  timestamptz,

  created_at                 timestamptz NOT NULL DEFAULT now(),

  UNIQUE (site_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_site_heat_logs_site_date ON site_heat_logs (site_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_site_heat_logs_company    ON site_heat_logs (company_id, log_date DESC);

ALTER TABLE site_heat_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "site_heat_logs_select_own" ON site_heat_logs;
CREATE POLICY "site_heat_logs_select_own"
  ON site_heat_logs FOR SELECT
  TO authenticated
  USING (is_company_member(company_id));

-- Nessuna policy INSERT/UPDATE/DELETE per authenticated: scritto solo dal
-- backend (service_role, cron di certificazione) — stesso pattern di
-- site_weather_logs. Le conferme/dismiss passano da un endpoint dedicato
-- (service_role dopo verifica ruolo owner/admin), mai una scrittura diretta
-- dal client.

-- Soglia interna configurabile (MAI presentata come soglia legale
-- automatica — la norma non ne prevede una vincolante): eredita dal
-- default azienda se non impostata sul cantiere, stesso pattern già in
-- uso per weather_rain_mm/weather_wind_kmh.
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS heat_temp_threshold_c NUMERIC,
  ADD COLUMN IF NOT EXISTS heat_alert_enabled     BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS heat_temp_threshold_c NUMERIC NOT NULL DEFAULT 35;

COMMENT ON COLUMN sites.heat_temp_threshold_c IS 'Soglia interna di allerta caldo (°C) — override del default azienda. NON è una soglia legale automatica: D.L. 107/2026 richiede una relazione tecnica multi-fattore, 35°C è solo "orientativa" per la norma.';
COMMENT ON TABLE site_heat_logs IS 'Registro caldo cantiere — dati certificati ARPAL (temperatura/umidità/radiazione) + indice WBGT stimato, a supporto della relazione tecnica D.L. 107/2026 art.6. Vedi commento in testa alla migrazione 218 per le fonti e i limiti.';
