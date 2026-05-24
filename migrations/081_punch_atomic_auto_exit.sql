-- ================================================================
-- Migration 081 — punch_atomic: auto-EXIT su cambio cantiere
--
-- Problema risolto:
--   Un lavoratore timbra ENTRY sul cantiere A, poi si sposta al
--   cantiere B e timbra ENTRY lì senza aver timbrato uscita da A.
--   Risultato attuale: presenza aperta su entrambi i cantieri.
--
-- Soluzione:
--   Quando punch_atomic crea un ENTRY, cerca eventuali ENTRY aperti
--   sugli ALTRI cantieri della stessa company per lo stesso worker,
--   nelle ultime 24 ore, e inserisce automaticamente un EXIT su
--   quei cantieri con lo stesso timestamp del nuovo ENTRY.
--   Le uscite automatiche hanno method = 'auto_exit_on_site_change'.
--
-- Il numero di cantieri chiusi automaticamente è restituito nella
-- risposta JSON: { ok, event_type, timestamp_server, auto_closed_sites }
--
-- Idempotente — CREATE OR REPLACE.
-- ================================================================

CREATE OR REPLACE FUNCTION punch_atomic(
  p_site_id     uuid,
  p_worker_id   uuid,
  p_company_id  uuid,
  p_session_id  uuid,           -- può essere NULL (badge punch)
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
  v_last_type        text;
  v_last_ts          timestamptz;
  v_event_type       text;
  v_now              timestamptz := clock_timestamp();
  v_secs_since       float8;
  v_auto_closed      integer := 0;
BEGIN
  -- ── 1. Advisory lock per (worker_id, site_id) — serializza punch simultanei ─
  PERFORM pg_advisory_xact_lock(
    hashtext(p_worker_id::text),
    hashtext(p_site_id::text)
  );

  -- ── 2. Ultimo punch del worker su QUESTO cantiere ────────────────────────────
  SELECT event_type, timestamp_server
  INTO   v_last_type, v_last_ts
  FROM   presence_logs
  WHERE  site_id   = p_site_id
  AND    worker_id = p_worker_id
  ORDER  BY timestamp_server DESC
  LIMIT  1;

  -- ── 3. Rate limit: blocca se < 60s dall'ultimo punch su questo cantiere ──────
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

  -- ── 4. event_type server-side: ENTRY → EXIT → ENTRY → … ────────────────────
  v_event_type := CASE WHEN v_last_type = 'ENTRY' THEN 'EXIT' ELSE 'ENTRY' END;

  -- ── 5. Auto-EXIT su altri cantieri (solo se stiamo creando un ENTRY) ─────────
  --
  -- Cerca tutti i cantieri DIVERSI da p_site_id dove l'ultimo log
  -- del worker nelle ultime 24 ore è un ENTRY aperto → inserisce EXIT.
  -- Threshold 24h: evita di toccare dati storici con uscite mancanti
  -- già gestite dal cron (quelle andrebbero revisionate dall'admin).
  --
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
    )
    SELECT
      p_company_id,
      oe.site_id,
      p_worker_id,
      'EXIT',
      v_now,
      p_lat,
      p_lon,
      NULL,     -- distanza non significativa per auto-exit
      NULL,
      p_ip,
      p_ua,
      NULL,     -- nessuna sessione per auto-exit
      'auto_exit_on_site_change'
    FROM open_entries oe
    WHERE oe.event_type = 'ENTRY';

    GET DIAGNOSTICS v_auto_closed = ROW_COUNT;
  END IF;

  -- ── 6. INSERT punch principale (atomico, dentro lo stesso lock) ──────────────
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

  -- ── 7. Risposta ──────────────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'ok',                true,
    'event_type',        v_event_type,
    'timestamp_server',  v_now,
    'auto_closed_sites', v_auto_closed
  );
END;
$$;
