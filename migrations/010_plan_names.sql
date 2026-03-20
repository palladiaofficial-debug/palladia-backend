-- Migration 010 — Aggiornamento nomi piani abbonamento
-- Nuovi piani: starter (€29, max 2 cantieri), grow (€59, max 6), pro (€99, max 15)
-- Migra i record esistenti con subscription_plan = 'base' → 'starter'.
-- Aggiorna il valore di default della colonna.

UPDATE companies
  SET subscription_plan = 'starter'
  WHERE subscription_plan = 'base';

ALTER TABLE companies
  ALTER COLUMN subscription_plan SET DEFAULT 'starter';
