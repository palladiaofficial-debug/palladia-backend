-- Migration 227: scadenza di pagamento reale su company_expenses (F-216, seguito).
-- Le fatture fornitore importate da A-Cube/email/importazione massiva contengono
-- spesso DataScadenzaPagamento nell'XML FatturaPA — mai estratta finora (vedi
-- lib/fatturaPaXmlParser.js). Nullable: resta null per tutto ciò che non ha una
-- scadenza reale dichiarata (spese manuali, DDT, ecc.) — mai una stima al suo posto.

ALTER TABLE company_expenses
  ADD COLUMN IF NOT EXISTS data_scadenza date;

CREATE INDEX IF NOT EXISTS idx_company_expenses_scadenza
  ON company_expenses (company_id, data_scadenza) WHERE data_scadenza IS NOT NULL;
