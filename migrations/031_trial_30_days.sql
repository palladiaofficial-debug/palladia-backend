-- Migration 031: estende trial da 14 a 30 giorni

-- 1. Cambia il DEFAULT per le nuove company
ALTER TABLE companies
  ALTER COLUMN trial_ends_at SET DEFAULT (now() + interval '30 days');

-- 2. Estende di 16 giorni (30-14) le company ancora in trial non scadute
UPDATE companies
SET trial_ends_at = trial_ends_at + interval '16 days'
WHERE subscription_status = 'trial'
  AND trial_ends_at > now();
