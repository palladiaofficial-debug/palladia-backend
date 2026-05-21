-- Migration 071: aggiunge birth_date (data di nascita) alla tabella workers
-- birth_place esiste già dalla migration 046; qui aggiungiamo solo la data.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS birth_date date;
