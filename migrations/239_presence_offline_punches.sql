-- 239 — Timbratura senza internet (F-284, mockup approvato il 2026-10-05)
-- L'operaio senza rete timbra lo stesso: il telefono salva ora e posizione e
-- le manda appena torna internet. Ogni timbratura arrivata così ha una riga
-- qui, e il titolare la vede in Da fare ("È giusta" / "Correggi").
--
-- Percorso separato da punch_atomic: la timbratura normale non cambia. La
-- funzione sotto prende però lo STESSO blocco per lavoratore di punch_atomic
-- (pg_advisory_xact_lock(hashtext(worker_id))), così una timbratura normale e
-- una arrivata dal telefono non si incrociano mai.
--
-- status:
--   registrata   scritta in presence_logs all'ora del telefono, il titolare può confermarla
--   da_decidere  NON scritta: qualcosa non torna (motivi in `flags`), il titolare decide
--   confermata   il titolare ha detto "È giusta"
--   corretta     il titolare l'ha registrata lui (da_decidere → riga admin_manual_correction)
CREATE TABLE IF NOT EXISTS presence_offline_punches (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_id          uuid        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id            uuid        NOT NULL,
  client_request_id  uuid        NOT NULL,
  expected_type      text        CHECK (expected_type IN ('ENTRY', 'EXIT')),
  event_type         text        NOT NULL CHECK (event_type IN ('ENTRY', 'EXIT')),
  punched_at         timestamptz NOT NULL,   -- ora del telefono, già corretta dello scarto noto
  device_at          timestamptz NOT NULL,   -- ora del telefono così come l'ha scritta
  received_at        timestamptz NOT NULL DEFAULT now(),
  latitude           double precision,
  longitude          double precision,
  gps_accuracy_m     double precision,
  distance_m         integer,
  flags              text[]      NOT NULL DEFAULT '{}',
  status             text        NOT NULL CHECK (status IN ('registrata', 'da_decidere', 'confermata', 'corretta')),
  log_id             uuid,
  resolved_by        uuid,
  resolved_at        timestamptz,
  resolution         jsonb,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
-- Lo stesso invio ripetuto (rete che va e viene) non crea doppioni
CREATE UNIQUE INDEX IF NOT EXISTS presence_offline_punches_request ON presence_offline_punches (worker_id, client_request_id);
CREATE INDEX IF NOT EXISTS presence_offline_punches_open ON presence_offline_punches (company_id, status);
ALTER TABLE presence_offline_punches ENABLE ROW LEVEL SECURITY;

-- Registra una timbratura arrivata dal telefono. I controlli che non
-- dipendono dallo stato delle timbrature (orologio, posizione, età) li fa
-- Node e li passa in p_flags: se ce n'è anche uno solo, non si scrive niente
-- in presence_logs. Qui, sotto il blocco, si guarda l'ordine rispetto alle
-- timbrature già registrate.
CREATE OR REPLACE FUNCTION offline_punch_atomic(
  p_company_id        uuid,
  p_worker_id         uuid,
  p_site_id           uuid,
  p_client_request_id uuid,
  p_expected_type     text,
  p_punched_at        timestamptz,
  p_device_at         timestamptz,
  p_lat               double precision,
  p_lon               double precision,
  p_accuracy_m        double precision,
  p_distance_m        integer,
  p_flags             text[],
  p_confirmed         boolean,
  p_ua                text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing   record;
  v_last_type  text;
  v_last_ts    timestamptz;
  v_last_site  uuid;
  v_event_type text;
  v_site_id    uuid := p_site_id;
  v_flags      text[] := COALESCE(p_flags, '{}');
  v_status     text;
  v_log_id     uuid := NULL;
  v_row_id     uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_worker_id::text));

  -- Stesso invio già arrivato: si restituisce quanto deciso la prima volta
  SELECT id, event_type, status, punched_at, flags INTO v_existing
  FROM presence_offline_punches
  WHERE worker_id = p_worker_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'id', v_existing.id,
      'event_type', v_existing.event_type, 'status', v_existing.status,
      'punched_at', v_existing.punched_at, 'flags', to_jsonb(v_existing.flags));
  END IF;

  SELECT event_type, timestamp_server, site_id INTO v_last_type, v_last_ts, v_last_site
  FROM presence_logs
  WHERE worker_id = p_worker_id AND company_id = p_company_id
  ORDER BY timestamp_server DESC
  LIMIT 1;

  -- Stessa regola di punch_atomic: se è aperto (da meno di 16 ore) questa è
  -- l'uscita, sul cantiere dove è entrato; altrimenti un'entrata.
  IF v_last_type = 'ENTRY' AND (p_punched_at - v_last_ts) <= interval '16 hours' THEN
    v_event_type := 'EXIT';
    v_site_id    := v_last_site;
  ELSE
    v_event_type := 'ENTRY';
  END IF;

  IF v_last_ts IS NOT NULL AND v_last_ts >= p_punched_at - interval '60 seconds' THEN
    -- Dopo (o quasi insieme a) un'altra timbratura già registrata: l'ordine non è certo
    v_flags := array_append(v_flags, 'dopo_altre');
  END IF;
  IF v_last_type = 'ENTRY' AND (p_punched_at - v_last_ts) > interval '16 hours' THEN
    v_flags := array_append(v_flags, 'entrata_vecchia_aperta');
  END IF;
  IF p_expected_type IS NOT NULL AND p_expected_type <> v_event_type THEN
    v_flags := array_append(v_flags, 'tipo_diverso');
  END IF;
  -- Stessa soglia di F-266: uscita a meno di 30 minuti dall'entrata, senza la conferma dell'operaio
  IF v_event_type = 'EXIT' AND NOT COALESCE(p_confirmed, false)
     AND (p_punched_at - v_last_ts) < interval '30 minutes' THEN
    v_flags := array_append(v_flags, 'uscita_breve');
  END IF;

  IF cardinality(v_flags) = 0 THEN
    INSERT INTO presence_logs (
      company_id, site_id, worker_id, event_type, timestamp_server,
      latitude, longitude, distance_m, gps_accuracy_m, ip_address, user_agent,
      session_id, method, client_request_id
    ) VALUES (
      p_company_id, v_site_id, p_worker_id, v_event_type, p_punched_at,
      p_lat, p_lon, p_distance_m, p_accuracy_m, NULL, p_ua,
      NULL, 'worker_offline_punch', p_client_request_id
    ) RETURNING id INTO v_log_id;
    v_status := 'registrata';
  ELSE
    v_status := 'da_decidere';
  END IF;

  INSERT INTO presence_offline_punches (
    company_id, worker_id, site_id, client_request_id, expected_type, event_type,
    punched_at, device_at, latitude, longitude, gps_accuracy_m, distance_m,
    flags, status, log_id, user_agent
  ) VALUES (
    p_company_id, p_worker_id, v_site_id, p_client_request_id, p_expected_type, v_event_type,
    p_punched_at, p_device_at, p_lat, p_lon, p_accuracy_m, p_distance_m,
    v_flags, v_status, v_log_id, p_ua
  ) RETURNING id INTO v_row_id;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'id', v_row_id,
    'event_type', v_event_type, 'status', v_status, 'punched_at', p_punched_at,
    'log_id', v_log_id, 'flags', to_jsonb(v_flags));
END;
$$;

REVOKE ALL ON FUNCTION offline_punch_atomic(uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, double precision, double precision, double precision, integer, text[], boolean, text) FROM PUBLIC, anon, authenticated;
