-- Migration 072: indici covering e partial per presence_logs
-- Obiettivo: accelerare export CSV annuali, query dashboard recenti, storico per lavoratore.
-- Tutti gli indici usano IF NOT EXISTS → idempotente.

-- 1. Covering index per export CSV range (site + periodo)
--    INCLUDE elimina il lookup alla tabella base per le colonne più usate negli export.
--    Beneficio: query presence-range con ORDER BY timestamp evita heap fetch.
CREATE INDEX IF NOT EXISTS idx_presence_site_ts_covering
  ON presence_logs (site_id, timestamp_server DESC)
  INCLUDE (worker_id, event_type, distance_m, gps_accuracy_m);

-- 2. Covering index per storico singolo lavoratore
--    Usato da workerHoursReport, ASL export, storico per worker.
CREATE INDEX IF NOT EXISTS idx_presence_worker_ts_covering
  ON presence_logs (worker_id, timestamp_server DESC)
  INCLUDE (event_type, site_id, distance_m, gps_accuracy_m);

-- 3. Indice company + site + timestamp — copre le query più comuni multi-colonna
--    (company_id + site_id usati insieme in quasi tutte le query autenticate)
CREATE INDEX IF NOT EXISTS idx_presence_company_site_ts
  ON presence_logs (company_id, site_id, timestamp_server DESC);

-- 4. Statistiche approfondite per il query planner su tabelle in crescita
ALTER TABLE presence_logs ALTER COLUMN company_id SET STATISTICS 1000;
ALTER TABLE presence_logs ALTER COLUMN site_id    SET STATISTICS 1000;
ALTER TABLE presence_logs ALTER COLUMN worker_id  SET STATISTICS 1000;

ANALYZE presence_logs;
