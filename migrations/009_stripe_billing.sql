-- Migration 009 — Stripe Billing
-- Aggiunge colonne abbonamento alla tabella companies.
-- trial_ends_at default: 14 giorni dalla creazione company.
-- subscription_status: 'trial' | 'active' | 'past_due' | 'canceled'

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS stripe_customer_id              text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id          text,
  ADD COLUMN IF NOT EXISTS subscription_status             text NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS subscription_plan               text NOT NULL DEFAULT 'base',
  ADD COLUMN IF NOT EXISTS trial_ends_at                   timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  ADD COLUMN IF NOT EXISTS subscription_current_period_end timestamptz;

-- Le companies già esistenti hanno trial_ends_at = now() + 14 giorni.
-- Questo è corretto: al lancio tutti iniziano il trial dal giorno della migration.

CREATE INDEX IF NOT EXISTS companies_stripe_customer_id_idx
  ON companies (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS companies_stripe_sub_id_idx
  ON companies (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
