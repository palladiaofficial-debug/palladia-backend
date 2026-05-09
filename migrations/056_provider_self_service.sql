-- Migration 056 — Self-service onboarding enti formatori

ALTER TABLE training_providers
  ADD COLUMN IF NOT EXISTS application_notes TEXT,
  ADD COLUMN IF NOT EXISTS applied_at        TIMESTAMPTZ;
