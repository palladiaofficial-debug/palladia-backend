-- 236 — Timbrature da sistemare: tipo "late_entry" (2026-10-03, regola del titolare)
-- La domanda "Stai iniziando a lavorare adesso?" nel pomeriggio è stata tolta
-- all'operaio (troppe scelte per operai di 50/60 anni, spesso stranieri). Il
-- primo tocco nel pomeriggio di chi di solito entra la mattina resta una
-- timbratura normale; il titolare trova il caso in Da fare.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'presence_fix_requests'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE presence_fix_requests DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE presence_fix_requests ADD CONSTRAINT presence_fix_requests_kind_check
  CHECK (kind IN ('missing_exit', 'forgot_entry', 'entry_not_exit', 'short_shift', 'late_entry'));
