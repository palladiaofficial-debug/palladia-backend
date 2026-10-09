-- 243 — Caldo, pausa saltata, entrata in ritardo (F-319, AUDIT.md del frontend, 2026-10-10)
-- Decisioni del titolare:
--   - "Fa troppo caldo" tra le risposte all'uscita anticipata, da giugno a settembre;
--     le ore le conferma il titolare, come la pioggia;
--   - "Ho saltato la pausa" se esce fino a 90 minuti prima: lo conferma il titolare
--     (la conferma scrive presence_lunch_overrides, già letto dal calcolo ore);
--   - chi entra almeno un'ora dopo il solito: una domanda (pioveva / permesso /
--     visita medica / ero in ritardo). Motivi propri, sull'ENTRATA: nei report
--     "Entrata in ritardo per…", mai "Uscita per…".
-- Nessuna modifica a presence_logs né alla timbratura.

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'presence_log_reasons'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%reason%'
             AND pg_get_constraintdef(oid) NOT ILIKE '%stato%'
  LOOP
    EXECUTE format('ALTER TABLE presence_log_reasons DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE presence_log_reasons ADD CONSTRAINT presence_log_reasons_reason_check
  CHECK (reason IN ('maltempo', 'malattia', 'permesso', 'pausa', 'infortunio',
                    'caldo', 'pausa_saltata',
                    'ritardo_maltempo', 'ritardo_permesso', 'visita_medica', 'ritardo'));

-- Pausa saltata confermata: quale override ha creato (per l'Annulla)
ALTER TABLE presence_log_reasons ADD COLUMN IF NOT EXISTS lunch_override_id uuid;
