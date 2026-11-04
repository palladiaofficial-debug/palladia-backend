-- F-432 (AUDIT.md del frontend): ore in più (straordinario) aggiunte dall'ufficio,
-- anche per i giorni passati. Tabella a parte: le timbrature (presence_logs)
-- restano intoccate. Si sommano allo straordinario del giorno in lib/oreMese.js.
CREATE TABLE IF NOT EXISTS ore_aggiunte (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_id   uuid        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id     uuid        REFERENCES sites(id) ON DELETE SET NULL,
  giorno      date        NOT NULL,
  minuti      integer     NOT NULL CHECK (minuti > 0 AND minuti <= 960),
  note        text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ore_aggiunte_mese ON ore_aggiunte (company_id, giorno);
ALTER TABLE ore_aggiunte ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
