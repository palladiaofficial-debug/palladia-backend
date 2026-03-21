-- Migration 011: aggiunge colonne profilo azienda alla tabella companies
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS piva          TEXT,
  ADD COLUMN IF NOT EXISTS address       TEXT,
  ADD COLUMN IF NOT EXISTS phone         TEXT,
  ADD COLUMN IF NOT EXISTS contact_email TEXT,
  ADD COLUMN IF NOT EXISTS safety_manager TEXT;
