-- Migration 086: Scadenza incasso SAL
-- Aggiunge data prevista di pagamento e data effettiva di incasso
-- su site_sal_history (da migration 085).

ALTER TABLE site_sal_history
  ADD COLUMN IF NOT EXISTS data_pagamento_prevista date,
  ADD COLUMN IF NOT EXISTS pagato_il              date;

CREATE INDEX IF NOT EXISTS site_sal_history_unpaid_idx
  ON site_sal_history (company_id, data_pagamento_prevista)
  WHERE pagato_il IS NULL;
