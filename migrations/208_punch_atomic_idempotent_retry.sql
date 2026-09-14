-- ================================================================
-- Migration 208 — punch_atomic: replay idempotente via client_request_id
-- (F-184, AUDIT.md)
--
-- Problema (osservato dal vivo il 2026-09-14 su Canameti Ibrahim e
-- Raksasoi Suriya, sospettato collegato alla VPN di un terzo
-- lavoratore, Petriccione Raffaele): il client (public/badge-punch.html)
-- non sa distinguere "la richiesta non è mai arrivata al server" da
-- "è arrivata ed è stata processata, ma la risposta si è persa" — su
-- QUALUNQUE errore di fetch (VPN che si riconnette, rete instabile)
-- mette il tentativo in una coda locale e lo rispedisce quando la
-- rete torna o alla pagina successiva. Se la prima richiesta era
-- invece arrivata a destinazione, il retry ripete lo stesso identico
-- payload contro un endpoint che è un TOGGLE (ENTRY/EXIT deciso
-- dall'ultimo evento) — il secondo invio capovolge lo stato:
-- un'ENTRY reale seguita, minuti dopo, da un'EXIT fantasma mentre il
-- lavoratore non si è mai mosso (GPS identico, dentro il geofence).
--
-- `presence_logs.session_id` esisteva già ma è una FK reale verso
-- `worker_device_sessions` (migrations/002) — non riusabile come
-- token libero di deduplicazione senza inventare una riga di sessione
-- dispositivo per ogni singolo tentativo, un concetto diverso.
-- `client_request_id` è una colonna dedicata, senza FK: un UUID
-- generato dal client per ogni TENTATIVO di timbratura (non per
-- richiesta HTTP), riusato identico se il client deve rimettere in
-- coda/rispedire lo stesso tentativo.
--
-- Soluzione: prima di decidere ENTRY/EXIT, il server controlla se
-- esiste già una riga con lo stesso worker_id+client_request_id: se
-- sì, la richiesta è un replay dello stesso tentativo — restituisce
-- il risultato già scritto invece di generare un nuovo evento.
-- L'indice unico è una seconda barriera (richieste concorrenti con lo
-- stesso client_request_id, non solo sequenziali) — non basarsi solo
-- sul controllo applicativo dentro l'advisory lock, che protegge la
-- sessione di questa chiamata ma non eventuali race tra connessioni
-- diverse prima che il lock sia preso.
--
-- Idempotente — ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION.
-- ================================================================

ALTER TABLE presence_logs ADD COLUMN IF NOT EXISTS client_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS presence_logs_worker_client_request_uniq
  ON presence_logs (worker_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION punch_atomic(
  p_site_id            uuid,
  p_worker_id          uuid,
  p_company_id         uuid,
  p_session_id         uuid,
  p_lat                double precision,
  p_lon                double precision,
  p_distance_m         integer,
  p_accuracy_m         numeric,
  p_ip                 text,
  p_ua                 text,
  p_method             text DEFAULT 'worker_self_punch',
  p_client_request_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_last_type          text;
  v_last_ts            timestamptz;
  v_last_site_id       uuid;
  v_event_type         text;
  v_target_site_id     uuid;
  v_closed_site_id     uuid := NULL;
  v_now                timestamptz := clock_timestamp();
  v_secs_since         float8;
  v_auto_closed_stale  boolean := false;
  v_stale_threshold    CONSTANT interval := '16 hours';
  v_replay             record;
BEGIN
  -- Lock globale per lavoratore (non più per worker+sito): con la nuova
  -- semantica esiste un solo stato "aperto/chiuso" per lavoratore, non uno
  -- per ciascun cantiere — due tocchi quasi simultanei su cantieri diversi
  -- devono comunque serializzarsi sullo stesso stato.
  PERFORM pg_advisory_xact_lock(hashtext(p_worker_id::text));

  -- F-184: replay dello stesso TENTATIVO (stesso client_request_id, non
  -- nullo) — non decidere di nuovo ENTRY/EXIT, restituisci quanto già scritto.
  IF p_client_request_id IS NOT NULL THEN
    SELECT event_type, timestamp_server, site_id
    INTO   v_replay
    FROM   presence_logs
    WHERE  worker_id = p_worker_id AND client_request_id = p_client_request_id
    LIMIT  1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok',                true,
        'event_type',        v_replay.event_type,
        'timestamp_server',  v_replay.timestamp_server,
        'site_id',           v_replay.site_id,
        'closed_site_id',    NULL,
        'auto_closed_stale', false,
        'replayed',          true
      );
    END IF;
  END IF;

  -- Ultimo evento del lavoratore in TUTTA l'azienda, non filtrato per sito.
  SELECT event_type, timestamp_server, site_id
  INTO   v_last_type, v_last_ts, v_last_site_id
  FROM   presence_logs
  WHERE  worker_id  = p_worker_id
  AND    company_id = p_company_id
  ORDER  BY timestamp_server DESC
  LIMIT  1;

  IF v_last_ts IS NOT NULL THEN
    v_secs_since := EXTRACT(EPOCH FROM (v_now - v_last_ts));
    IF v_secs_since < 60 THEN
      RETURN jsonb_build_object(
        'ok',               false,
        'error',            'PUNCH_TOO_SOON',
        'retry_after_secs', CEIL(60 - v_secs_since)::integer
      );
    END IF;
  END IF;

  IF v_last_type = 'ENTRY' AND v_last_ts IS NOT NULL AND (v_now - v_last_ts) > v_stale_threshold THEN
    -- Turno-fantasma: l'apertura è troppo vecchia per essere lo stesso
    -- turno — chiudila a un orario plausibile, poi tratta questo tocco
    -- come una nuova ENTRY (sul cantiere toccato ora).
    INSERT INTO presence_logs (
      company_id, site_id, worker_id, event_type, timestamp_server,
      latitude, longitude, distance_m, gps_accuracy_m, ip_address, user_agent,
      session_id, method
    ) VALUES (
      p_company_id, v_last_site_id, p_worker_id, 'EXIT', v_last_ts + INTERVAL '9 hours',
      NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, 'auto_exit_stale_before_reopen'
    );
    v_auto_closed_stale := true;
    v_event_type     := 'ENTRY';
    v_target_site_id := p_site_id;

  ELSIF v_last_type = 'ENTRY' THEN
    -- Il lavoratore è aperto da qualche parte (non-stale) — QUALUNQUE
    -- cantiere tocchi ora chiude quell'apertura, mai una nuova ENTRY
    -- altrove. Se il cantiere toccato è quello stesso dove è aperto,
    -- è semplicemente la sua uscita normale; se è un cantiere diverso,
    -- l'uscita viene comunque taggata sul cantiere ORIGINALE (dove ha
    -- davvero lavorato), non su quello toccato.
    v_event_type     := 'EXIT';
    v_target_site_id := v_last_site_id;
    IF v_last_site_id <> p_site_id THEN
      v_closed_site_id := v_last_site_id;
    END IF;

  ELSE
    -- Nessuna apertura in corso (mai timbrato, o ultimo evento EXIT) →
    -- nuova ENTRY sul cantiere toccato.
    v_event_type     := 'ENTRY';
    v_target_site_id := p_site_id;
  END IF;

  INSERT INTO presence_logs (
    company_id, site_id, worker_id, event_type, timestamp_server,
    latitude, longitude, distance_m, gps_accuracy_m, ip_address, user_agent,
    session_id, method, client_request_id
  ) VALUES (
    p_company_id, v_target_site_id, p_worker_id, v_event_type, v_now,
    p_lat, p_lon, p_distance_m, p_accuracy_m, p_ip, p_ua,
    p_session_id, p_method, p_client_request_id
  );

  RETURN jsonb_build_object(
    'ok',                  true,
    'event_type',          v_event_type,
    'timestamp_server',    v_now,
    'site_id',             v_target_site_id,
    'closed_site_id',      v_closed_site_id,
    'auto_closed_stale',   v_auto_closed_stale,
    'replayed',            false
  );
END;
$$;
