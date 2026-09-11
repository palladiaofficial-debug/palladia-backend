-- ================================================================
-- Migration 201 — punch_atomic: decisione ENTRY/EXIT globale per
-- lavoratore, non più per singolo cantiere (F-172, AUDIT.md)
--
-- Problema (sweep completo del 2026-09-11, dopo una settimana di
-- incidenti reali sulle timbrature — F-150/168/169/170/171):
--   La versione precedente decideva ENTRY/EXIT guardando SOLO
--   l'ultimo evento allo STESSO cantiere (p_site_id). Se un
--   lavoratore entra al cantiere A e più tardi tocca un cantiere B
--   MAI toccato prima (es. esce dal magazzino invece che dal
--   cantiere, o incrocia un altro cantiere entro il raggio) —
--   scenario reale richiesto esplicitamente dal titolare più volte
--   oggi ("ingresso in un cantiere, uscita in un altro") — il
--   sistema:
--     1. Decideva ENTRY a B (nessuna storia locale a B).
--     2. Chiudeva correttamente A con un EXIT automatico
--        (auto_exit_on_site_change) — le ore di A restavano giuste.
--     3. Ma lasciava un'ENTRY aperta e MAI richiesta a B, che
--        restava "in corso" finché la guardia anti-turno-fantasma
--        (16h, migrations/161) non la chiudeva da sola con un EXIT
--        fabbricato a +9h — ore FALSE attribuite a un cantiere dove
--        il lavoratore non ha mai lavorato.
--   Lo stesso bias (ultimo evento SOLO per questo sito) esisteva
--   anche in services/missingExitCron.js e
--   services/ladiaActions.js::registerMissingExits — fabbricavano
--   un'uscita mancante per un'ENTRY che in realtà il lavoratore
--   aveva già chiuso correttamente altrove.
--
-- Soluzione — nessuna ambiguità, nessuna scelta silenziosa:
--   La decisione ENTRY/EXIT si basa ORA sull'ultimo evento del
--   lavoratore in TUTTA l'azienda (non filtrato per sito). Se il
--   lavoratore è "aperto" (ultima ENTRY senza EXIT) su un cantiere
--   qualunque e tocca un ALTRO cantiere, il tocco chiude SEMPRE
--   quell'apertura (EXIT taggato sul cantiere ORIGINALE, non su
--   quello toccato) — non apre mai una nuova ENTRY altrove. Per
--   iniziare davvero un nuovo turno su un cantiere diverso durante
--   la stessa giornata bastano due tocchi espliciti (prima l'uscita,
--   poi l'ingresso al nuovo cantiere) invece di una singola
--   "magia" implicita — la stessa ambiguità che ha causato il bug.
--
--   La guardia anti-turno-fantasma (161) resta identica ma ora
--   opera sull'evento globale, non per-sito. Il vecchio blocco
--   "auto-EXIT su altri cantieri" (081) diventa superfluo — con la
--   nuova logica non può mai esistere più di un'ENTRY aperta per
--   lavoratore, quindi è stato rimosso.
--
-- Risposta JSON: nuovo campo `closed_site_id` — presente e diverso
-- da p_site_id quando il tocco ha chiuso un'apertura su un ALTRO
-- cantiere (il chiamante lo usa per un messaggio corretto, es.
-- "Uscita registrata da Via Riboli 4b" anche se il lavoratore ha
-- toccato "Magazzino").
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
  v_last_site_id       uuid;
  v_event_type         text;
  v_target_site_id     uuid;
  v_closed_site_id     uuid := NULL;
  v_now                timestamptz := clock_timestamp();
  v_secs_since         float8;
  v_auto_closed_stale  boolean := false;
  v_stale_threshold    CONSTANT interval := '16 hours';
BEGIN
  -- Lock globale per lavoratore (non più per worker+sito): con la nuova
  -- semantica esiste un solo stato "aperto/chiuso" per lavoratore, non uno
  -- per ciascun cantiere — due tocchi quasi simultanei su cantieri diversi
  -- devono comunque serializzarsi sullo stesso stato.
  PERFORM pg_advisory_xact_lock(hashtext(p_worker_id::text));

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
    session_id, method
  ) VALUES (
    p_company_id, v_target_site_id, p_worker_id, v_event_type, v_now,
    p_lat, p_lon, p_distance_m, p_accuracy_m, p_ip, p_ua,
    p_session_id, p_method
  );

  RETURN jsonb_build_object(
    'ok',                  true,
    'event_type',          v_event_type,
    'timestamp_server',    v_now,
    'site_id',             v_target_site_id,
    'closed_site_id',      v_closed_site_id,
    'auto_closed_stale',   v_auto_closed_stale
  );
END;
$$;
