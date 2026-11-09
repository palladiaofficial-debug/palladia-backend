-- F-478 (AUDIT.md del frontend): «Petriccione molte volte inizia alle 7 perché
-- fa il trasportatore… ma il sistema lo conta solo dalle 8». L'ufficio segna un
-- giorno come «partito prima su richiesta»: quel giorno l'orario si sposta
-- all'ora vera di entrata (stessa durata: 07:00 → fine 16:00). Una riga per
-- lavoratore e giorno; anche per i giorni passati. Le timbrature
-- (presence_logs) restano intoccate: questa tabella dice solo come contarle.
CREATE TABLE IF NOT EXISTS ore_inizio_anticipato (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_id        uuid        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  giorno           date        NOT NULL,
  nota             text,
  created_by       uuid,
  created_by_email text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ore_inizio_anticipato_un_giorno UNIQUE (company_id, worker_id, giorno)
);
CREATE INDEX IF NOT EXISTS ore_inizio_anticipato_mese ON ore_inizio_anticipato (company_id, giorno);
ALTER TABLE ore_inizio_anticipato ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
