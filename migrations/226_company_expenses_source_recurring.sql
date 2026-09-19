-- Migration 226: aggiunge 'recurring' ai source ammessi su company_expenses
-- (F-216, seguito) — le spese fisse mensili materializzate da
-- services/recurringExpenseCron.js usano questo source.

ALTER TABLE company_expenses DROP CONSTRAINT IF EXISTS company_expenses_source_check;
ALTER TABLE company_expenses ADD CONSTRAINT company_expenses_source_check
  CHECK (source IN ('manual', 'acube', 'email', 'sdi_massive', 'badge_ddt', 'recurring'));
