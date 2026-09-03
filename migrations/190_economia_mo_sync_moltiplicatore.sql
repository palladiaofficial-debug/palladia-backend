-- 190_economia_mo_sync_moltiplicatore.sql
-- BLOCCO 2 — applica il moltiplicatore costo-azienda (migrazione 189) al
-- sync manodopera. Il moltiplicatore compare sempre in chiaro nella nota
-- della riga (vincolo: mai un valore implicito nel calcolo) e viene
-- ricalcolato ad ogni sync, quindi cambiarlo in company aggiorna
-- automaticamente il costo manodopera di tutti i cantieri al prossimo giro.

CREATE OR REPLACE FUNCTION sync_site_mo_consuntivo(p_site_id uuid) RETURNS void AS $$
DECLARE
  v_company_id   uuid;
  v_moltiplicatore numeric(4,2);
BEGIN
  SELECT company_id INTO v_company_id FROM sites WHERE id = p_site_id;
  IF v_company_id IS NULL THEN RETURN; END IF;

  SELECT moltiplicatore_costo_manodopera INTO v_moltiplicatore FROM companies WHERE id = v_company_id;
  v_moltiplicatore := COALESCE(v_moltiplicatore, 1.45);

  DELETE FROM site_economia_movimenti
    WHERE site_id = p_site_id AND sorgente = 'timbratura' AND source_table = 'presence_logs_aggregate';

  INSERT INTO site_economia_movimenti (
    company_id, site_id, tipo, categoria, importo, data_competenza,
    sorgente, source_table, source_id, note, created_at, updated_at
  )
  SELECT
    v_company_id, p_site_id, 'consuntivo', 'manodopera',
    ROUND(SUM(ore) * MAX(tariffa_oraria) * v_moltiplicatore, 2),
    CURRENT_DATE,
    'timbratura', 'presence_logs_aggregate', p_site_id::text || ':' || worker_id::text,
    full_name || ' — ' || ROUND(SUM(ore), 2) || ' ore × ' || MAX(tariffa_oraria) || '€/h × moltiplicatore '
      || v_moltiplicatore || ' = costo azienda', now(), now()
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

-- Riallinea tutti i cantieri con timbrature al nuovo calcolo (con moltiplicatore).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT site_id FROM presence_logs LOOP
    PERFORM sync_site_mo_consuntivo(r.site_id);
  END LOOP;
END $$;
