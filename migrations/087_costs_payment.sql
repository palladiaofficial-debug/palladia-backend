-- Migration 087: Tracciamento pagamento costi diretti (fatture ricevute)
ALTER TABLE site_costs ADD COLUMN IF NOT EXISTS pagato_il date;

CREATE INDEX IF NOT EXISTS site_costs_unpaid_idx
  ON site_costs (company_id, data_documento)
  WHERE pagato_il IS NULL;
