-- Migration 175: backfill di equipment.name per le righe rimaste NULL.
-- La colonna esiste da 148 ma POST/PATCH /equipment non l'hanno mai scritta
-- (solo il tool Ladia create_equipment lo faceva) — scoperto costruendo
-- l'unificazione documenti (Scaglione 4), che legge questa colonna
-- direttamente per la cartella "Mezzi". routes/v1/equipment.js ora la scrive
-- sempre; questo backfill copre solo le righe create prima del fix.

UPDATE equipment
SET name = TRIM(BOTH ' ' FROM COALESCE(type, '') || ' ' || COALESCE(model, ''))
WHERE name IS NULL;

UPDATE equipment SET name = 'Mezzo' WHERE name IS NULL OR name = '';
