-- Migration 222: DDT caricati dal badge trasportatore su un cantiere non ancora
-- censito in Palladia — finiscono in company_expenses (spesa generale, non
-- legata a un site_id) invece che in site_costs (che richiede site_id NOT NULL).
--
-- Un DDT quasi mai riporta un importo (stesso motivo di site_costs.importo,
-- migrazione 221) — amount qui è NOT NULL CHECK > 0 dalla 107, va rilassato
-- allo stesso modo: Number(null) vale 0 in JS, non altera nessun totale
-- esistente (routes/v1/expenses.js::/summary usa già Number(e.amount)).

ALTER TABLE company_expenses ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE company_expenses DROP CONSTRAINT IF EXISTS company_expenses_amount_check;
ALTER TABLE company_expenses ADD CONSTRAINT company_expenses_amount_check
  CHECK (amount IS NULL OR amount > 0);

-- Nuova origine spesa: DDT caricato dal trasportatore interno via badge,
-- distinta dalle altre (vedi migrazioni 132/165/171 per la storia del vincolo).
ALTER TABLE company_expenses DROP CONSTRAINT IF EXISTS company_expenses_source_check;
ALTER TABLE company_expenses ADD CONSTRAINT company_expenses_source_check
  CHECK (source IN ('manual', 'acube', 'email', 'sdi_massive', 'badge_ddt'));
