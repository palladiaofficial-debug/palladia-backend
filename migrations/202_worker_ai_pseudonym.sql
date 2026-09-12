-- ================================================================
-- Migration 202 — codice pseudonimo stabile per lavoratore (F-176,
-- AUDIT.md), usato al posto di full_name/id nei dati mandati a
-- Claude via Ladia. La mappa nome<->codice resta nel nostro DB,
-- protetta dalla stessa RLS di `workers` — mai esposta a terzi.
-- ================================================================

ALTER TABLE workers ADD COLUMN IF NOT EXISTS ai_pseudonym_code text UNIQUE;

-- Backfill una tantum per i lavoratori esistenti. Formato: LAV- +
-- 6 caratteri esadecimali maiuscoli, non derivato dall'id (nessun
-- collegamento decifrabile senza consultare la tabella).
UPDATE workers
SET ai_pseudonym_code = 'LAV-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6))
WHERE ai_pseudonym_code IS NULL;

COMMENT ON COLUMN workers.ai_pseudonym_code IS
  'Codice stabile mandato a Claude al posto di full_name/id (F-176). Generato per i nuovi lavoratori in lib/ladiaSchemaRegistry.js (serverInjected).';
