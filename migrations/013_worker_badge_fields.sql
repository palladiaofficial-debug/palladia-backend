-- ============================================================
-- Migration 013 — Badge Digitale: campi aggiuntivi su workers
-- ============================================================
-- Eseguire in Supabase > SQL Editor
-- Richiede pgcrypto (abilitato di default su Supabase)

-- ── Fase 1: aggiungi colonne nullable ─────────────────────────────────────────
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS photo_url               text,
  ADD COLUMN IF NOT EXISTS hire_date               date,
  ADD COLUMN IF NOT EXISTS qualification           text,
  ADD COLUMN IF NOT EXISTS role                    text,
  ADD COLUMN IF NOT EXISTS employer_name           text,
  ADD COLUMN IF NOT EXISTS subcontracting_auth     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS safety_training_expiry  date,
  ADD COLUMN IF NOT EXISTS health_fitness_expiry   date,
  ADD COLUMN IF NOT EXISTS badge_code              text;

-- ── Fase 2: genera badge_code per tutti i lavoratori esistenti ────────────────
-- 9 byte → 18 char hex uppercase (72 bit di casualità — spazio 2^72, non enumerabile)
-- Ogni esecuzione è idempotente: aggiorna solo le righe con badge_code NULL.
UPDATE workers
SET badge_code = upper(encode(gen_random_bytes(9), 'hex'))
WHERE badge_code IS NULL;

-- ── Fase 3: NOT NULL + constraint + indice ────────────────────────────────────
ALTER TABLE workers
  ALTER COLUMN badge_code SET NOT NULL;

-- UNIQUE constraint (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_badge_code_unique'
      AND conrelid = 'workers'::regclass
  ) THEN
    ALTER TABLE workers
      ADD CONSTRAINT workers_badge_code_unique UNIQUE (badge_code);
  END IF;
END $$;

-- Indice B-tree per lookup O(log n) dalla pagina pubblica di verifica
CREATE INDEX IF NOT EXISTS idx_workers_badge_code ON workers (badge_code);

-- ── Commento colonne (documentazione schema) ──────────────────────────────────
COMMENT ON COLUMN workers.badge_code              IS '18-char hex uppercase, univoco per lavoratore — cuore del badge digitale anticontraffazione';
COMMENT ON COLUMN workers.photo_url               IS 'URL pubblico foto lavoratore (Supabase Storage)';
COMMENT ON COLUMN workers.hire_date               IS 'Data assunzione';
COMMENT ON COLUMN workers.qualification           IS 'Qualifica contrattuale (es. Operaio specializzato)';
COMMENT ON COLUMN workers.role                    IS 'Mansione specifica in cantiere (es. Carpentiere)';
COMMENT ON COLUMN workers.employer_name           IS 'Ragione sociale impresa di appartenenza — può differire dalla company per subappaltatori';
COMMENT ON COLUMN workers.subcontracting_auth     IS 'Lavoratore autorizzato al subappalto';
COMMENT ON COLUMN workers.safety_training_expiry  IS 'Scadenza attestato formazione sicurezza D.Lgs 81/2008';
COMMENT ON COLUMN workers.health_fitness_expiry   IS 'Scadenza idoneità sanitaria (visita medica)';
