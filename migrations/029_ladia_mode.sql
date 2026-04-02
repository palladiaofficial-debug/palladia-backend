-- Migration 029: Ladia mode su telegram_users
-- Traccia se l'utente è in modalità conversazione con Ladia.
ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS ladia_mode boolean NOT NULL DEFAULT false;
