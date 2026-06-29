-- 112_payslips_unique_constraint.sql
-- Fix: il POST /workers/:workerId/payslips usava upsert con onConflict ma mancava
-- il UNIQUE constraint — ogni upload falliva con DB_ERROR (500).

-- Prima elimina l'indice non-unique se esiste
DROP INDEX IF EXISTS idx_payslips_company_worker;

-- Crea il constraint UNIQUE (necessario per upsert onConflict)
ALTER TABLE payslips
  DROP CONSTRAINT IF EXISTS payslips_company_worker_period_uniq;

ALTER TABLE payslips
  ADD CONSTRAINT payslips_company_worker_period_uniq
  UNIQUE (company_id, worker_id, period_year, period_month);

-- Ricrea l'indice sulle colonne rimanenti per le query di lista
CREATE INDEX IF NOT EXISTS idx_payslips_company_worker_list
  ON payslips(company_id, worker_id, period_year DESC, period_month DESC);
