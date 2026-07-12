-- Migration 133: conservazione a norma per le fatture fornitore ricevute via SdI.
-- Le fatture elettroniche vanno per legge conservate 10 anni in modo certificato
-- ("conservazione sostitutiva"). La migrazione 132 salvava solo il JSON in
-- company_expenses, non sufficiente da sola — questa aggiunge il tracciamento
-- dello stato di conservazione reale presso il provider.

ALTER TABLE company_expenses
  ADD COLUMN IF NOT EXISTS sdi_legal_storage_status       text,   -- to_be_stored | sent | stored | error
  ADD COLUMN IF NOT EXISTS sdi_legal_storage_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS sdi_legal_storage_object_id    text;   -- id del documento conservato lato provider

ALTER TABLE sdi_configurations
  ADD COLUMN IF NOT EXISTS legal_storage_enabled boolean NOT NULL DEFAULT true;
