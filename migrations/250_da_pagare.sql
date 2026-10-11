-- 250 — F-338 (AUDIT.md del frontend): Da pagare.
-- Una lista dei pagamenti da non dimenticare (chi, quanto, entro quando), dentro
-- Da fare. Usa company_expenses, che ha già fornitore, importo, data_scadenza,
-- pagato_il, numero fattura e foto (receipt_url): si aggiunge solo ciò che manca.
--   da_pagare     la riga appartiene alla lista (creata da Da pagare o arrivata
--                 per email con il modulo acceso); le spese vecchie restano fuori
--   sollecitato   "mi ha sollecitato": rosso anche se non è scaduta
--   rimandato_al  "Rimanda": la riga torna in lista da quel giorno
-- Nessuna categoria, cantiere o centro di costo nuovo: confine scritto nel mockup.
ALTER TABLE company_expenses
  ADD COLUMN IF NOT EXISTS da_pagare    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sollecitato  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rimandato_al date;

CREATE INDEX IF NOT EXISTS company_expenses_da_pagare_aperti
  ON company_expenses (company_id, data_scadenza)
  WHERE da_pagare AND pagato_il IS NULL;
