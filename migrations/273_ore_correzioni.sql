-- F-435 (AUDIT.md del frontend): l'ufficio corregge l'orario di un giorno dalla
-- tabella delle ore (timbrato in ritardo, uscita mancante, badge dimenticato).
-- Tabella a parte, una riga per lavoratore e giorno: presence_logs resta
-- intoccato (append-only). lib/oreMese.js conta il giorno da questo orario con
-- la stessa contaGiorno delle timbrature (ritardo, pausa, straordinario a
-- blocchi, sabato/domenica/festivi tutto straordinario).
CREATE TABLE IF NOT EXISTS ore_correzioni (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_id        uuid        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id          uuid        REFERENCES sites(id) ON DELETE SET NULL,
  giorno           date        NOT NULL,
  entrata          time        NOT NULL,
  uscita           time        NOT NULL,
  nota             text,
  orig_entrata     text,
  orig_uscita      text,
  created_by       uuid,
  created_by_email text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ore_correzioni_un_giorno UNIQUE (company_id, worker_id, giorno),
  CONSTRAINT ore_correzioni_orari CHECK (entrata <> uscita)
);
CREATE INDEX IF NOT EXISTS ore_correzioni_mese ON ore_correzioni (company_id, giorno);
ALTER TABLE ore_correzioni ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
