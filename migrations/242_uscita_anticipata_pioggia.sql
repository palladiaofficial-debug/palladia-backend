-- 242 — Pioggia, permesso, malattia e infortunio (F-318, AUDIT.md del frontend, 2026-10-09)
-- Il titolare: "i miei operai dicono che non hanno queste opzioni". Decisioni del titolare:
--   - l'operaio che esce PRIMA del solito sceglie un motivo (piove / permesso /
--     sto male / mi sono fatto male / ho finito) dopo che l'uscita è già registrata;
--   - la pioggia dichiarata dall'operaio conta solo quando la conferma il titolare;
--   - giornata intera di pioggia senza timbrature: ore di maltempo per chi doveva esserci;
--   - malattia comunicata dall'operaio dall'Area lavoratore.
-- Nessuna modifica a presence_logs né alla timbratura.

-- Motivi d'uscita: anche l'infortunio
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'presence_log_reasons'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%reason%'
  LOOP
    EXECUTE format('ALTER TABLE presence_log_reasons DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE presence_log_reasons ADD CONSTRAINT presence_log_reasons_reason_check
  CHECK (reason IN ('maltempo', 'malattia', 'permesso', 'pausa', 'infortunio'));

-- Chi l'ha detto e se vale: le righe esistenti (dall'ufficio) restano confermate
ALTER TABLE presence_log_reasons ADD COLUMN IF NOT EXISTS da_lavoratore boolean NOT NULL DEFAULT false;
ALTER TABLE presence_log_reasons ADD COLUMN IF NOT EXISTS stato text NOT NULL DEFAULT 'confermato';
ALTER TABLE presence_log_reasons DROP CONSTRAINT IF EXISTS presence_log_reasons_stato_check;
ALTER TABLE presence_log_reasons ADD CONSTRAINT presence_log_reasons_stato_check
  CHECK (stato IN ('da_confermare', 'confermato', 'scartato'));
ALTER TABLE presence_log_reasons ADD COLUMN IF NOT EXISTS decided_by uuid;
ALTER TABLE presence_log_reasons ADD COLUMN IF NOT EXISTS decided_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_presence_log_reasons_da_confermare
  ON presence_log_reasons (company_id) WHERE stato = 'da_confermare';

-- Assenze: anche il maltempo (giornata intera senza timbrature), col cantiere
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'worker_absences'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%tipo%'
  LOOP
    EXECUTE format('ALTER TABLE worker_absences DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE worker_absences ADD CONSTRAINT worker_absences_tipo_check
  CHECK (tipo IN ('ferie', 'permesso', 'malattia', 'altro', 'maltempo'));
ALTER TABLE worker_absences ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES sites(id) ON DELETE SET NULL;
ALTER TABLE worker_absences ADD COLUMN IF NOT EXISTS ore_min integer CHECK (ore_min IS NULL OR (ore_min > 0 AND ore_min <= 720));
