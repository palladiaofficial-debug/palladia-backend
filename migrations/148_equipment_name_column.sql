-- Migration 148: aggiunge la colonna 'name' a equipment, mai esistita.
-- Trovato dal primo run reale della suite LADIA_EVALS (2026-08-06): il tool
-- create_equipment di Ladia scrive da sempre su equipment.name, colonna che
-- non è mai esistita in nessuna migrazione (014/037) — create_equipment via
-- Ladia non ha mai funzionato per nessun utente reale, sempre fallito in
-- silenzio con un errore di schema. assign_equipment_to_site legge lo stesso
-- campo fantasma per mostrare un nome leggibile.

ALTER TABLE equipment
  ADD COLUMN IF NOT EXISTS name text;

-- Backfill delle righe esistenti (create dal form diretto, non da Ladia).
UPDATE equipment
SET name = TRIM(BOTH ' ' FROM COALESCE(type, '') || ' ' || COALESCE(model, ''))
WHERE name IS NULL;

UPDATE equipment SET name = 'Mezzo' WHERE name IS NULL OR name = '';
