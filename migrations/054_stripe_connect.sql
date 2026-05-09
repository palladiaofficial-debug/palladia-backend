-- Migration 054 — Stripe Connect per consulenti RSPP
-- Aggiunge campi account Express su consultant_profiles

ALTER TABLE consultant_profiles
  ADD COLUMN IF NOT EXISTS stripe_account_id          TEXT,
  ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled     BOOLEAN NOT NULL DEFAULT FALSE;

-- Indice per lookup nel webhook account.updated
CREATE INDEX IF NOT EXISTS idx_consultant_profiles_stripe_account
  ON consultant_profiles (stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;
