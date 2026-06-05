-- 096_payslips.sql
-- Cedolini paga caricati dallo studio CDL per ogni lavoratore dell'impresa cliente.

CREATE TABLE IF NOT EXISTS payslips (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id     UUID        NOT NULL REFERENCES studio_partners(id) ON DELETE CASCADE,
  company_id    UUID        NOT NULL REFERENCES companies(id)        ON DELETE CASCADE,
  worker_id     UUID        REFERENCES workers(id)                   ON DELETE SET NULL,
  period_year   SMALLINT    NOT NULL,
  period_month  SMALLINT    NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  filename      TEXT        NOT NULL,
  file_path     TEXT        NOT NULL,
  file_size     INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payslips_company_worker ON payslips(company_id, worker_id, period_year DESC, period_month DESC);
CREATE INDEX IF NOT EXISTS idx_payslips_studio         ON payslips(studio_id, company_id);
