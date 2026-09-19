-- Migration 225: collega una spesa generata da una spesa fissa mensile al suo
-- template (F-216, seguito) — così la previsione di cassa può riconoscere
-- un'occorrenza già materializzata/pagata invece di continuare a proiettarla
-- all'infinito dal solo template.

ALTER TABLE company_expenses
  ADD COLUMN IF NOT EXISTS recurring_expense_id uuid REFERENCES company_recurring_expenses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_company_expenses_recurring
  ON company_expenses (recurring_expense_id) WHERE recurring_expense_id IS NOT NULL;
