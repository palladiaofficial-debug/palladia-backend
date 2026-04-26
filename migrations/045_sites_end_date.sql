-- Migration 045: aggiunge end_date ai cantieri per countdown scadenza
ALTER TABLE sites ADD COLUMN IF NOT EXISTS end_date DATE;
