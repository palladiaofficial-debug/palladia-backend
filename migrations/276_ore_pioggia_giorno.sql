-- F-486 (AUDIT.md del frontend): «dare la possibilità ai tecnici di segnare
-- tutto il giorno pioggia o meno». Decisione dell'ufficio per lavoratore e
-- giorno, sopra la regola automatica delle 10 (F-485):
--   intero = true  → pioggia tutto il giorno (0 ore lavorate, giornata di pioggia)
--   intero = false → ore lavorate fino all'uscita + il resto di pioggia
--   nessuna riga   → vale la regola automatica dell'impresa
-- Le timbrature (presence_logs) restano intoccate: dice solo come contarle.
CREATE TABLE IF NOT EXISTS ore_pioggia_giorno (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_id        uuid        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  giorno           date        NOT NULL,
  intero           boolean     NOT NULL,
  created_by       uuid,
  created_by_email text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ore_pioggia_giorno_un_giorno UNIQUE (company_id, worker_id, giorno)
);
CREATE INDEX IF NOT EXISTS ore_pioggia_giorno_mese ON ore_pioggia_giorno (company_id, giorno);
ALTER TABLE ore_pioggia_giorno ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
