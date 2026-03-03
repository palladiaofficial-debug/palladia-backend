-- Migration 004 — gps_accuracy_m su presence_logs
-- Applica DOPO 003_append_only.sql
-- Idempotente: usa IF NOT EXISTS

ALTER TABLE presence_logs
  ADD COLUMN IF NOT EXISTS gps_accuracy_m numeric(8,2);

-- Commento colonna (documentazione DB)
COMMENT ON COLUMN presence_logs.gps_accuracy_m IS
  'Precisione GPS dichiarata dal client (metri). NULL su record pre-migrazione o client vecchi. Colonna audit: non modificabile (trigger append-only).';
