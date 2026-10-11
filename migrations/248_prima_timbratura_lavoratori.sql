-- 248 — F-335 (AUDIT.md del frontend): la prima timbratura di ogni lavoratore
-- in una sola lettura. Il foglio del mese la usa per capire chi ha iniziato a
-- usare Palladia a metà mese (quei giorni non sono "da giustificare"); prima
-- era una query per lavoratore (230 query per l'azienda di prova, oltre 15 s).
-- Sola lettura su presence_logs.
CREATE OR REPLACE FUNCTION prima_timbratura_lavoratori(p_company uuid, p_workers uuid[])
RETURNS TABLE (worker_id uuid, prima timestamptz)
LANGUAGE sql STABLE
AS $$
  SELECT pl.worker_id, min(pl.timestamp_server)
  FROM presence_logs pl
  WHERE pl.company_id = p_company AND pl.worker_id = ANY (p_workers)
  GROUP BY pl.worker_id
$$;
REVOKE ALL ON FUNCTION prima_timbratura_lavoratori(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
