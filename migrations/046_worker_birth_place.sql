-- Migration 046: aggiunge luogo di nascita al profilo lavoratore
ALTER TABLE workers ADD COLUMN IF NOT EXISTS birth_place text;
