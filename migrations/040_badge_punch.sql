-- ================================================================
-- Migration 040 — Badge Punch: metodo timbratura + session nullable
--
-- 1. Estende punch_atomic con p_method (worker_self_punch,
--    capocantiere_action, ladia_action, admin_manual_action).
-- 2. Garantisce che presence_logs.session_id sia nullable
--    (i punch via badge non creano una worker_device_session).
--
-- Idempotente — CREATE OR REPLACE / IF NOT EXISTS.
-- Eseguire in Supabase → SQL Editor → Run.
-- ================================================================

-- Assicura che session_id ammetta NULL (badge punch non usa sessioni)
ALTER TABLE presence_logs ALTER COLUMN session_id DROP NOT NULL;

-- Aggiorna punch_atomic con parametro p_method
CREATE OR REPLACE FUNCTION punch_atomic(
  p_site_id     uuid,
  p_worker_id   uuid,
  p_company_id  uuid,
  p_session_id  uuid,           -- può essere NULL per punch via badge
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
  v_last_type   text;
  v_last_ts     timestamptz;
  v_event_type  text;
  v_now         timestamptz := clock_timestamp();
  v_secs_since  float8;
BEGIN
  -- 1. Advisory lock transazionale per (worker_id, site_id)
  PERFORM pg_advisory_xact_lock(
    hashtext(p_worker_id::text),
    hashtext(p_site_id::text)
  );

  -- 2. Ultimo punch del worker su questo cantiere (dentro il lock)
  SELECT event_type, timestamp_server
  INTO   v_last_type, v_last_ts
  FROM   presence_logs
  WHERE  site_id   = p_site_id
  AND    worker_id = p_worker_id
  ORDER  BY timestamp_server DESC
  LIMIT  1;

  -- 3. Rate limit applicativo: blocca se < 60s dall'ultimo punch
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

  -- 4. event_type determinato server-side
  v_event_type := CASE WHEN v_last_type = 'ENTRY' THEN 'EXIT' ELSE 'ENTRY' END;

  -- 5. INSERT atomico
  INSERT INTO presence_logs (
    company_id,
    site_id,
    worker_id,
    event_type,
    timestamp_server,
    latitude,
    longitude,
    distance_m,
    gps_accuracy_m,
    ip_address,
    user_agent,
    session_id,
    method
  ) VALUES (
    p_company_id,
    p_site_id,
    p_worker_id,
    v_event_type,
    v_now,
    p_lat,
    p_lon,
    p_distance_m,
    p_accuracy_m,
    p_ip,
    p_ua,
    p_session_id,
    p_method
  );

  -- 6. Risposta successo
  RETURN jsonb_build_object(
    'ok',               true,
    'event_type',       v_event_type,
    'timestamp_server', v_now
  );
END;
$$;
