-- Migration 076: ripristina il constraint UNIQUE su worksite_workers
-- Il constraint era definito nella migration 002 ma potrebbe non essere presente
-- nel DB di produzione. CREATE UNIQUE INDEX CONCURRENTLY è safe su tabelle con dati.

CREATE UNIQUE INDEX IF NOT EXISTS worksite_workers_unique
  ON worksite_workers (site_id, worker_id);
