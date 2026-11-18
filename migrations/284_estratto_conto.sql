-- 284 — F-513 (AUDIT.md del frontend): l'estratto conto della banca segna le fatture pagate davvero.
-- Il titolare carica il file dei movimenti (Excel/CSV); i movimenti si salvano una volta sola
-- (impronta per impresa: ricaricare lo stesso mese non li raddoppia); le fatture di Da pagare
-- confermate dal titolare prendono la data del bonifico e il segno «lo dice la banca».
-- Sono soldi: RLS accesa e nessuna policy, li legge solo il server (owner/admin).
CREATE TABLE IF NOT EXISTS estratti_conto (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  nome_file   text,
  movimenti   integer NOT NULL DEFAULT 0,
  dal         date,
  al          date,
  caricato_da uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS estratto_movimenti (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  estratto_id uuid NOT NULL REFERENCES estratti_conto(id) ON DELETE CASCADE,
  data        date NOT NULL,
  importo     numeric(14,2) NOT NULL,
  descrizione text,
  impronta    text NOT NULL,
  scartato_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, impronta)
);
CREATE INDEX IF NOT EXISTS estratto_movimenti_company_data ON estratto_movimenti (company_id, data DESC);
ALTER TABLE estratti_conto ENABLE ROW LEVEL SECURITY;
ALTER TABLE estratto_movimenti ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS pagato_banca_at timestamptz;
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS pagato_movimento_id uuid REFERENCES estratto_movimenti(id) ON DELETE SET NULL;
