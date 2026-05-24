-- 079_company_durc_expiry.sql
-- Aggiunge durc_expiry alla tabella companies per tracciare il DURC dell'impresa principale.
-- I subappaltatori hanno già il campo (migration precedente).
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS durc_expiry DATE;
