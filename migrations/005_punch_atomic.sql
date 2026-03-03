-- ================================================================
-- Migration 005 — Funzione RPC punch_atomic (race-condition proof)
-- Eseguire in Supabase → SQL Editor → Run
--
-- Risolve la race condition nel punch flow di scan.js:
--   Due richieste simultanee per lo stesso worker non possono più
--   creare stati incoerenti (double ENTRY o double EXIT).
--
-- Meccanismo:
--   pg_advisory_xact_lock(worker_hash, site_hash)
--   → serializza i punch per (worker_id, site_id) dentro la stessa transaction.
--   La seconda richiesta attende che la prima completi l'INSERT prima
--   di leggere il lastLog.
--
-- La funzione:
--   1. Acquisisce l'advisory lock transazionale
--   2. Legge l'ultimo punch (dentro il lock)
--   3. Verifica il rate limit applicativo (60s)
--   4. Determina event_type SERVER-SIDE
--   5. Fa INSERT presence_log (dentro il lock)
--   6. Rilascia il lock automaticamente al termine della transaction
--
-- SECURITY DEFINER: la funzione viene eseguita con i privilegi del suo
-- owner (normalmente postgres/authenticator). Il backend usa la service
-- key che bypassa già la RLS, ma SECURITY DEFINER garantisce uniformità.
--
-- Idempotente: CREATE OR REPLACE — sicura da rieseguire.
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
  p_ua          text
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
  -- ── 1. Advisory lock transazionale per (worker_id, site_id) ───────────────
  -- Due punch simultanei per lo stesso worker+cantiere vengono serializzati.
  -- La lock è rilasciata automaticamente alla fine della transaction.
  -- hashtext() è built-in PostgreSQL: nessuna estensione richiesta.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_worker_id::text),
    hashtext(p_site_id::text)
  );

  -- ── 2. Ultimo punch del worker su questo cantiere (dentro il lock) ─────────
  SELECT event_type, timestamp_server
  INTO   v_last_type, v_last_ts
  FROM   presence_logs
  WHERE  site_id   = p_site_id
  AND    worker_id = p_worker_id
  ORDER  BY timestamp_server DESC
  LIMIT  1;

  -- ── 3. Rate limit applicativo: blocca se < 60s dall'ultimo punch ───────────
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

  -- ── 4. event_type determinato server-side: ENTRY → EXIT → ENTRY → … ───────
  v_event_type := CASE WHEN v_last_type = 'ENTRY' THEN 'EXIT' ELSE 'ENTRY' END;

  -- ── 5. INSERT atomico (dentro la stessa transaction del lock) ──────────────
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
    'personal_phone'
  );

  -- ── 6. Risposta successo ────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'ok',               true,
    'event_type',       v_event_type,
    'timestamp_server', v_now
  );
END;
$$;

-- ================================================================
-- VERIFICA FUNZIONAMENTO (eseguire in SQL Editor):
--
--   SELECT punch_atomic(
--     '<site_uuid>',
--     '<worker_uuid>',
--     '<company_uuid>',
--     '<session_uuid>',
--     45.0, 9.0, 15, 10.5, '127.0.0.1', 'test-ua'
--   );
--   -- Deve ritornare: {"ok": true, "event_type": "ENTRY", ...}
--
--   -- Eseguire immediatamente di seguito (rate limit check):
--   SELECT punch_atomic(...stessi params...);
--   -- Deve ritornare: {"ok": false, "error": "PUNCH_TOO_SOON", ...}
-- ================================================================
