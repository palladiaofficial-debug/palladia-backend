-- F-422 (AUDIT.md del frontend): le bolle (documenti di trasporto) del cantiere, con i materiali.
-- Una riga per bolla; i materiali in `righe` [{descrizione, quantita, unita}], come li ha letti
-- Palladia e confermati dal titolare. `fattura_id` resta vuoto fino al confronto (passo 5).
CREATE TABLE IF NOT EXISTS bolle (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id         uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  fornitore       text,
  fornitore_piva  text,
  numero          text,
  data            date,
  firmata         boolean,
  righe           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  file_path       text,
  mime_type       text,
  content_hash    text,
  origine         text        NOT NULL DEFAULT 'carica' CHECK (origine IN ('carica', 'email', 'badge')),
  fattura_id      uuid,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bolle_cantiere ON bolle (company_id, site_id, data DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS bolle_hash ON bolle (company_id, content_hash);
ALTER TABLE bolle ENABLE ROW LEVEL SECURITY;
