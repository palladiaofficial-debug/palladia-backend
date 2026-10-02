-- 233 — Ferie, permessi, malattia (F-265)
-- Assenze di un lavoratore, registrate dall'ufficio (stato 'approvata')
-- oppure chieste dal lavoratore dall'Area lavoratore (stato 'richiesta',
-- poi 'approvata' o 'rifiutata' dal titolare). Non toccano presence_logs:
-- il riepilogo del mese le affianca alle ore timbrate.
CREATE TABLE IF NOT EXISTS worker_absences (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_id     uuid        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  tipo          text        NOT NULL CHECK (tipo IN ('ferie', 'permesso', 'malattia', 'altro')),
  date_from     date        NOT NULL,
  date_to       date        NOT NULL,
  ora_dalle     time,
  ora_alle      time,
  protocollo    text,
  note          text,
  stato         text        NOT NULL DEFAULT 'approvata' CHECK (stato IN ('richiesta', 'approvata', 'rifiutata')),
  da_lavoratore boolean     NOT NULL DEFAULT false,
  created_by    uuid,
  decided_by    uuid,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from)
);
CREATE INDEX IF NOT EXISTS worker_absences_company_dates ON worker_absences (company_id, date_from, date_to);
CREATE INDEX IF NOT EXISTS worker_absences_worker ON worker_absences (worker_id, date_from);
ALTER TABLE worker_absences ENABLE ROW LEVEL SECURITY;

-- "Perché esci?" dopo l'uscita: anche la pausa pranzo è un motivo (F-265).
-- La tabella resta di sola lettura per i report: mai passata al pairing.
-- Toglie il CHECK su "reason" qualunque sia il nome generato dalla 217.
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
  CHECK (reason IN ('maltempo', 'malattia', 'permesso', 'pausa'));
