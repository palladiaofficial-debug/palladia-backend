-- ================================================================
-- Migration 003 — Append-only trigger + PIN sicuro
-- Eseguire in Supabase → SQL Editor → Run
-- ================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. TRIGGER APPEND-ONLY su presence_logs
--
-- Blocca UPDATE e DELETE a livello PostgreSQL.
-- Funziona con QUALSIASI ruolo, incluso service_role e postgres.
-- RLS non è sufficiente: la service key la bypassa.
-- Il trigger BEFORE è più efficiente (non materializza la modifica).
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _presence_logs_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'presence_logs is append-only: % not allowed', TG_OP;
END;
$$;

-- Crea i trigger (DROP IF EXISTS prima per idempotenza)
DROP TRIGGER IF EXISTS tg_presence_no_update ON presence_logs;
DROP TRIGGER IF EXISTS tg_presence_no_delete ON presence_logs;

CREATE TRIGGER tg_presence_no_update
  BEFORE UPDATE ON presence_logs
  FOR EACH ROW EXECUTE FUNCTION _presence_logs_append_only();

CREATE TRIGGER tg_presence_no_delete
  BEFORE DELETE ON presence_logs
  FOR EACH ROW EXECUTE FUNCTION _presence_logs_append_only();

-- ──────────────────────────────────────────────────────────────
-- 2. PIN SICURO: sostituisce pin_code (plaintext) con pin_hash
--
-- pin_hash = HMAC-SHA256(PIN_SIGNING_SECRET, pin)
-- La chiave è nel backend (.env), non nel DB.
--
-- PROCEDURA DI MIGRAZIONE:
--   STEP A) Eseguire questa migration (aggiunge pin_hash, pin_code resta).
--   STEP B) Deploy codice aggiornato (usa pin_hash).
--   STEP C) Per ogni cantiere con PIN, eseguire:
--             node scripts/set-site-pin.js <site_id> <pin>
--   STEP D) Verificare che nessun cantiere usi più pin_code.
--   STEP E) Decommentare e rieseguire il DROP COLUMN qui sotto.
-- ──────────────────────────────────────────────────────────────
ALTER TABLE sites ADD COLUMN IF NOT EXISTS pin_hash text;

-- STEP E: decommentare SOLO dopo aver convertito tutti i PIN con set-site-pin.js
-- ALTER TABLE sites DROP COLUMN IF EXISTS pin_code;

COMMIT;

-- ================================================================
-- VERIFICA: dopo l'esecuzione testare il trigger manualmente:
--
--   -- questo deve fallire con "presence_logs is append-only":
--   UPDATE presence_logs SET event_type = 'EXIT' WHERE id = (
--     SELECT id FROM presence_logs LIMIT 1
--   );
--
--   -- questo deve fallire:
--   DELETE FROM presence_logs WHERE id = (
--     SELECT id FROM presence_logs LIMIT 1
--   );
-- ================================================================
