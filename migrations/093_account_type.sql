-- Migration 093: account_type su companies
-- Differenzia imprese edili, studi CDL, provider formazione e consulenti RSPP.
-- Tutti i record esistenti restano 'impresa' (default retrocompatibile).

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'impresa'
  CONSTRAINT companies_account_type_check
  CHECK (account_type IN ('impresa', 'studio_cdl', 'provider', 'consulente'));

CREATE INDEX IF NOT EXISTS idx_companies_account_type ON companies(account_type);
