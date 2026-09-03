-- 188_economia_mo_sync_fix.sql
-- Fix di sync_site_mo_consuntivo() (migrazione 187), due bug trovati dal test
-- di regressione scripts/selftest_economia_movimenti_sync.js (AUDIT.md F-119),
-- non da lettura del codice:
--
-- 1. Il LAG() era calcolato DOPO aver filtrato event_type='EXIT', quindi
--    confrontava ogni EXIT con l'EXIT precedente invece che con l'ENTRY
--    corrispondente — ore sempre 0, nessuna riga generata. Il LAG ora scorre
--    TUTTI gli eventi (ENTRY+EXIT) per worker in ordine cronologico, poi si
--    filtra sulle coppie EXIT che seguono un ENTRY — stessa semantica
--    "ultimo ENTRY vince" della state machine in calcPnl() (economia.js).
--
-- 2. La chiave sintetica delle righe manodopera usava solo worker_id come
--    source_id: un lavoratore che timbra su PIÙ cantieri genera righe con
--    la stessa (sorgente, source_table, source_id, tipo) per cantieri
--    diversi → violazione del vincolo UNIQUE in produzione (trovato dal
--    backfill reale su dati multi-company, non dal test isolato). source_id
--    ora è composito "site_id:worker_id".

CREATE OR REPLACE FUNCTION sync_site_mo_consuntivo(p_site_id uuid) RETURNS void AS $$
DECLARE
  v_company_id uuid;
BEGIN
  SELECT company_id INTO v_company_id FROM sites WHERE id = p_site_id;
  IF v_company_id IS NULL THEN RETURN; END IF;

  DELETE FROM site_economia_movimenti
    WHERE site_id = p_site_id AND sorgente = 'timbratura' AND source_table = 'presence_logs_aggregate';

  INSERT INTO site_economia_movimenti (
    company_id, site_id, tipo, categoria, importo, data_competenza,
    sorgente, source_table, source_id, note, created_at, updated_at
  )
  SELECT
    v_company_id, p_site_id, 'consuntivo', 'manodopera',
    ROUND(SUM(ore) * MAX(tariffa_oraria), 2),
    CURRENT_DATE,
    'timbratura', 'presence_logs_aggregate', p_site_id::text || ':' || worker_id::text,
    full_name || ' — ' || ROUND(SUM(ore), 2) || ' ore', now(), now()
  FROM (
    SELECT worker_id, full_name, tariffa_oraria, ore
    FROM (
      SELECT
        pl.worker_id, w.full_name, w.tariffa_oraria, pl.event_type,
        LAG(pl.event_type)       OVER (PARTITION BY pl.worker_id ORDER BY pl.timestamp_server) AS prev_event_type,
        LEAST(GREATEST(
          EXTRACT(EPOCH FROM (
            pl.timestamp_server - LAG(pl.timestamp_server) OVER (PARTITION BY pl.worker_id ORDER BY pl.timestamp_server)
          )) / 3600.0, 0), 24) AS ore
      FROM presence_logs pl
      JOIN workers w ON w.id = pl.worker_id
      WHERE pl.site_id = p_site_id
        AND w.tariffa_oraria IS NOT NULL AND w.tariffa_oraria > 0
    ) eventi
    WHERE event_type = 'EXIT' AND prev_event_type = 'ENTRY'
  ) sessioni
  WHERE ore > 0.01
  GROUP BY worker_id, full_name
  HAVING SUM(ore) > 0.01;
END;
$$ LANGUAGE plpgsql;

-- Ripeti il backfill con la funzione corretta per tutti i cantieri con timbrature.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT site_id FROM presence_logs LOOP
    PERFORM sync_site_mo_consuntivo(r.site_id);
  END LOOP;
END $$;
