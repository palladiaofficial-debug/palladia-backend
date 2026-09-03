-- 187_economia_movimenti_verify_and_mo.sql
-- BLOCCO 1 — funzione di verifica allineamento (stesso schema di
-- verify_documents_sync, migrazione 174) + funzione di sync manodopera.
--
-- Le timbrature NON hanno un trigger AFTER INSERT riga-per-riga: una riga
-- presence_logs è un singolo evento ENTRY/EXIT, il costo si ricava solo
-- appaiando sessioni complete (stessa logica di calcPnl in economia.js) — un
-- trigger per singolo evento dovrebbe ricalcolare l'intero storico ore del
-- lavoratore ad ogni timbratura, costoso e fragile. Si usa invece una
-- funzione RPC richiamabile on-demand (dallo script di backfill/verifica, o
-- in futuro dal caricamento della schermata Economia) che ricalcola le righe
-- consuntivo/manodopera per un cantiere. Applica tariffa_oraria NUDA — il
-- moltiplicatore costo-azienda (Blocco 2) la aggiornerà.

CREATE OR REPLACE FUNCTION sync_site_mo_consuntivo(p_site_id uuid) RETURNS void AS $$
DECLARE
  v_company_id uuid;
BEGIN
  SELECT company_id INTO v_company_id FROM sites WHERE id = p_site_id;
  IF v_company_id IS NULL THEN RETURN; END IF;

  -- Rimuovi le righe esistenti per questo cantiere e ricalcola da zero:
  -- più semplice e sicuro di un upsert incrementale, il volume per cantiere
  -- (una riga per lavoratore) è piccolo.
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
    'timbratura', 'presence_logs_aggregate', worker_id::text,
    full_name || ' — ' || ROUND(SUM(ore), 2) || ' ore', now(), now()
  FROM (
    -- Appaia ENTRY/EXIT consecutivi per worker, come calcPnl() in economia.js
    SELECT
      pl.worker_id, w.full_name, w.tariffa_oraria,
      LEAST(GREATEST(
        EXTRACT(EPOCH FROM (
          pl.timestamp_server - LAG(pl.timestamp_server) OVER (PARTITION BY pl.worker_id ORDER BY pl.timestamp_server)
        )) / 3600.0, 0), 24) AS ore
    FROM presence_logs pl
    JOIN workers w ON w.id = pl.worker_id
    WHERE pl.site_id = p_site_id
      AND pl.event_type = 'EXIT'
      AND w.tariffa_oraria IS NOT NULL AND w.tariffa_oraria > 0
  ) sessioni
  WHERE ore > 0.01
  GROUP BY worker_id, full_name
  HAVING SUM(ore) > 0.01;
END;
$$ LANGUAGE plpgsql;

-- Backfill iniziale per tutti i cantieri con timbrature.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT site_id FROM presence_logs LOOP
    PERFORM sync_site_mo_consuntivo(r.site_id);
  END LOOP;
END $$;

-- ── Funzione di verifica allineamento ────────────────────────────────────────
CREATE OR REPLACE FUNCTION verify_economia_movimenti_sync()
RETURNS TABLE(
  source_table      text,
  source_count      bigint,
  movimenti_count   bigint,
  mismatched_count  bigint,
  orphaned_count    bigint
) LANGUAGE sql STABLE AS $$

  SELECT
    'company_expenses'::text,
    (SELECT count(*) FROM company_expenses WHERE site_id IS NOT NULL),
    (SELECT count(*) FROM site_economia_movimenti WHERE sorgente = 'fattura' AND source_table = 'company_expenses'),
    (SELECT count(*) FROM company_expenses ce
       LEFT JOIN site_economia_movimenti m
         ON m.sorgente = 'fattura' AND m.source_table = 'company_expenses' AND m.source_id = ce.id::text
       WHERE ce.site_id IS NOT NULL
         AND (m.id IS NULL
              OR m.site_id  IS DISTINCT FROM ce.site_id
              OR m.importo  IS DISTINCT FROM ce.amount
              OR m.categoria IS DISTINCT FROM economia_categoria_da_testo(ce.category))),
    (SELECT count(*) FROM site_economia_movimenti m
       LEFT JOIN company_expenses ce ON ce.id::text = m.source_id
       WHERE m.source_table = 'company_expenses' AND ce.id IS NULL)

  UNION ALL

  SELECT
    'site_costs'::text,
    (SELECT count(*) FROM site_costs),
    (SELECT count(*) FROM site_economia_movimenti WHERE sorgente = 'fattura' AND source_table = 'site_costs'),
    (SELECT count(*) FROM site_costs sc
       LEFT JOIN site_economia_movimenti m
         ON m.sorgente = 'fattura' AND m.source_table = 'site_costs' AND m.source_id = sc.id::text
       WHERE m.id IS NULL
          OR m.site_id  IS DISTINCT FROM sc.site_id
          OR m.importo  IS DISTINCT FROM sc.importo
          OR m.categoria IS DISTINCT FROM economia_categoria_da_testo(sc.categoria)),
    (SELECT count(*) FROM site_economia_movimenti m
       LEFT JOIN site_costs sc ON sc.id::text = m.source_id
       WHERE m.source_table = 'site_costs' AND sc.id IS NULL)

  UNION ALL

  SELECT
    'site_computo'::text,
    (SELECT count(*) FROM site_computo
       WHERE totale_contratto IS NOT NULL AND (tipo = 'base' OR (tipo = 'variante' AND stato = 'approvata'))),
    (SELECT count(*) FROM site_economia_movimenti WHERE sorgente = 'computo' AND source_table = 'site_computo'),
    (SELECT count(*) FROM site_computo sco
       LEFT JOIN site_economia_movimenti m
         ON m.sorgente = 'computo' AND m.source_table = 'site_computo' AND m.source_id = sco.id::text
       WHERE sco.totale_contratto IS NOT NULL AND (sco.tipo = 'base' OR (sco.tipo = 'variante' AND sco.stato = 'approvata'))
         AND (m.id IS NULL OR m.importo IS DISTINCT FROM sco.totale_contratto)),
    (SELECT count(*) FROM site_economia_movimenti m
       LEFT JOIN site_computo sco ON sco.id::text = m.source_id
       WHERE m.source_table = 'site_computo' AND sco.id IS NULL)

  UNION ALL

  SELECT
    'site_subcontracts'::text,
    (SELECT count(*) FROM site_subcontracts WHERE stato IN ('emesso', 'chiuso')),
    (SELECT count(*) FROM site_economia_movimenti WHERE sorgente = 'contratto' AND source_table = 'site_subcontracts'),
    (SELECT count(*) FROM site_subcontracts ssc
       LEFT JOIN site_economia_movimenti m
         ON m.sorgente = 'contratto' AND m.source_table = 'site_subcontracts' AND m.source_id = ssc.id::text
       WHERE ssc.stato IN ('emesso', 'chiuso')
         AND (m.id IS NULL OR m.importo IS DISTINCT FROM ssc.importo_pattuito)),
    (SELECT count(*) FROM site_economia_movimenti m
       LEFT JOIN site_subcontracts ssc ON ssc.id::text = m.source_id
       WHERE m.source_table = 'site_subcontracts' AND ssc.id IS NULL)

  UNION ALL

  SELECT
    'site_subcontract_sal'::text,
    (SELECT count(*) FROM site_subcontract_sal),
    (SELECT count(*) FROM site_economia_movimenti WHERE sorgente = 'sal' AND source_table = 'site_subcontract_sal'),
    (SELECT count(*) FROM site_subcontract_sal s
       LEFT JOIN site_economia_movimenti m
         ON m.sorgente = 'sal' AND m.source_table = 'site_subcontract_sal' AND m.source_id = s.id::text
       WHERE m.id IS NULL OR m.importo IS DISTINCT FROM s.importo),
    (SELECT count(*) FROM site_economia_movimenti m
       LEFT JOIN site_subcontract_sal s ON s.id::text = m.source_id
       WHERE m.source_table = 'site_subcontract_sal' AND s.id IS NULL)

  UNION ALL

  SELECT
    'site_sal_history'::text,
    (SELECT count(*) FROM site_sal_history WHERE importo_maturato IS NOT NULL),
    (SELECT count(*) FROM site_economia_movimenti WHERE sorgente = 'sal' AND source_table = 'site_sal_history'),
    0::bigint,  -- il delta è calcolato, non un confronto 1:1 diretto — vedi orphaned_count per l'unico controllo affidabile
    (SELECT count(*) FROM site_economia_movimenti m
       LEFT JOIN site_sal_history sh ON sh.id::text = m.source_id
       WHERE m.source_table = 'site_sal_history' AND sh.id IS NULL)

$$;
