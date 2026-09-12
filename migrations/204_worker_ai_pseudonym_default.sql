-- ================================================================
-- Migration 204 — fix su F-176: la migrazione 202 backfillava solo i
-- lavoratori esistenti, ma non impostava un DEFAULT a livello di colonna.
-- Risultato verificato dal vivo (2026-09-12): un lavoratore creato con un
-- semplice INSERT (percorso REST normale /api/v1/workers, non passando per
-- create_record di Ladia) restava con ai_pseudonym_code NULL — quindi
-- INVISIBILE alla pseudonimizzazione, il suo nome reale sarebbe finito in
-- chiaro nel prossimo tool_result che lo riguarda. Un DEFAULT a livello di
-- colonna copre OGNI percorso di inserimento (Ladia, REST, script admin),
-- non solo quello passato per lib/ladiaSchemaRegistry.js.
-- ================================================================

ALTER TABLE workers ALTER COLUMN ai_pseudonym_code
  SET DEFAULT ('LAV-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6)));

-- Backfill di sicurezza per eventuali righe inserite tra la 202 e questa
-- migrazione senza passare per Ladia (stesso rischio appena descritto).
UPDATE workers
SET ai_pseudonym_code = 'LAV-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6))
WHERE ai_pseudonym_code IS NULL;
