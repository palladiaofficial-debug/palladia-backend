-- ================================================================
-- Migration 161 — punch_atomic: guardia anti-turno-fantasma
--
-- Problema (F-043, AUDIT.md):
--   punch_atomic decide ENTRY/EXIT guardando solo l'ultimo evento
--   sullo STESSO cantiere, senza controllare quanto è vecchio. Se
--   un'uscita resta aperta per giorni (es. il cron missing-exit non
--   l'ha chiusa lo stesso giorno — vedi fix separato in
--   services/missingExitCron.js), il tocco successivo del lavoratore
--   viene abbinato come EXIT di quel turno vecchio, creando un turno
--   di durata assurda (osservato: 6 giorni, Giuseppe Di Leonardo,
--   MSCedilizia) invece di aprirne uno nuovo.
--
-- Soluzione:
--   Se l'ultimo evento è un ENTRY più vecchio di STALE_ENTRY_HOURS
--   (16h — copre un turno lungo con straordinario, ma non un giorno
--   intero), il tocco corrente NON viene abbinato come EXIT. Invece:
--     1. L'ENTRY vecchia viene chiusa automaticamente con un EXIT a
--        un orario plausibile (v_last_ts + 9h, il turno standard),
--        method='auto_exit_stale_before_reopen'.
--     2. Il tocco corrente diventa una nuova ENTRY.
--   auto_closed_stale nella risposta JSON indica se è successo,
--   cosi il frontend può informare l'utente ("ho chiuso un turno
--   rimasto aperto dal giorno X prima di aprirne uno nuovo").
--
-- Idempotente — CREATE OR REPLACE.
-- ================================================================

CREATE OR REPLACE FUNCTION punch_atomic(
  p_site_id     uuid,
  p_worker_id   uuid,
  p_company_id  uuid,
  p_session_id  uuid,
  p_lat         double precision,
  p_lon         double precision,
  p_distance_m  integer,
  p_accuracy_m  numeric,
  p_ip          text,
  p_ua          text,
  p_method      text DEFAULT 'worker_self_punch'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_last_type          text;
  v_last_ts            timestamptz;
  v_event_type         text;
  v_now                timestamptz := clock_timestamp();
  v_secs_since         float8;
  v_auto_closed        integer := 0;
  v_auto_closed_stale  boolean := false;
  v_stale_threshold    CONSTANT interval := '16 hours';
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(p_worker_id::text),
    hashtext(p_site_id::text)
  );

  SELECT event_type, timestamp_server
  INTO   v_last_type, v_last_ts
  FROM   presence_logs
  WHERE  site_id   = p_site_id
  AND    worker_id = p_worker_id
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

  -- ── 4. event_type server-side, con guardia anti-turno-fantasma ─────────────
  IF v_last_type = 'ENTRY' AND v_last_ts IS NOT NULL AND (v_now - v_last_ts) > v_stale_threshold THEN
    -- L'ultima ENTRY è troppo vecchia per essere lo stesso turno: chiudila
    -- automaticamente a un orario plausibile invece di abbinarci il tocco
    -- corrente, poi tratta questo tocco come una nuova ENTRY.
    INSERT INTO presence_logs (
      company_id, site_id, worker_id, event_type, timestamp_server,
      latitude, longitude, distance_m, gps_accuracy_m, ip_address, user_agent,
      session_id, method
    ) VALUES (
      p_company_id, p_site_id, p_worker_id, 'EXIT', v_last_ts + INTERVAL '9 hours',
      NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, 'auto_exit_stale_before_reopen'
    );
    v_auto_closed_stale := true;
    v_event_type := 'ENTRY';
  ELSE
    v_event_type := CASE WHEN v_last_type = 'ENTRY' THEN 'EXIT' ELSE 'ENTRY' END;
  END IF;

  -- ── 5. Auto-EXIT su altri cantieri (solo se stiamo creando un ENTRY) ─────────
  IF v_event_type = 'ENTRY' THEN
    WITH open_entries AS (
      SELECT DISTINCT ON (site_id)
        site_id,
        event_type
      FROM   presence_logs
      WHERE  worker_id        = p_worker_id
        AND  company_id       = p_company_id
        AND  site_id         <> p_site_id
        AND  timestamp_server >  v_now - INTERVAL '24 hours'
      ORDER  BY site_id, timestamp_server DESC
    )
    INSERT INTO presence_logs (
      company_id, site_id, worker_id, event_type, timestamp_server,
      latitude, longitude, distance_m, gps_accuracy_m, ip_address, user_agent,
      session_id, method
    )
    SELECT
      p_company_id, oe.site_id, p_worker_id, 'EXIT', v_now,
      p_lat, p_lon, NULL, NULL, p_ip, p_ua,
      NULL, 'auto_exit_on_site_change'
    FROM open_entries oe
    WHERE oe.event_type = 'ENTRY';

    GET DIAGNOSTICS v_auto_closed = ROW_COUNT;
  END IF;

  -- ── 6. INSERT punch principale (atomico, dentro lo stesso lock) ──────────────
  INSERT INTO presence_logs (
    company_id, site_id, worker_id, event_type, timestamp_server,
    latitude, longitude, distance_m, gps_accuracy_m, ip_address, user_agent,
    session_id, method
  ) VALUES (
    p_company_id, p_site_id, p_worker_id, v_event_type, v_now,
    p_lat, p_lon, p_distance_m, p_accuracy_m, p_ip, p_ua,
    p_session_id, p_method
  );

  -- ── 7. Risposta ──────────────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'ok',                  true,
    'event_type',          v_event_type,
    'timestamp_server',    v_now,
    'auto_closed_sites',   v_auto_closed,
    'auto_closed_stale',   v_auto_closed_stale
  );
END;
$$;
