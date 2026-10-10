-- 245 — F-331 (AUDIT.md del frontend): Lavagna cantieri.
-- Una riga per cantiere: urgenza, cosa c'è da fare, nota, scritte dal titolare.
-- site_id NULL = cantiere "solo nella lavagna" (sta per iniziare o è finito e
-- non è mai stato registrato): non è un cantiere, non conta nel piano, non si
-- timbra. fase conta solo per queste righe; per un cantiere registrato lo
-- stato vero è sites.status, e fase = 'da_iniziare' è solo un'indicazione.
CREATE TABLE IF NOT EXISTS lavagna_righe (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id     uuid REFERENCES sites(id) ON DELETE CASCADE,
  nome        text NOT NULL DEFAULT '' CHECK (char_length(nome) <= 120),
  fase        text NOT NULL DEFAULT 'in_corso' CHECK (fase IN ('da_iniziare', 'in_corso', 'fermo', 'consegnato')),
  urgenza     text NOT NULL DEFAULT 'nessuna' CHECK (urgenza IN ('rosso', 'giallo', 'verde', 'nessuna')),
  da_fare     text NOT NULL DEFAULT '' CHECK (char_length(da_fare) <= 300),
  note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  CONSTRAINT lavagna_righe_sito_unico UNIQUE (company_id, site_id),
  CONSTRAINT lavagna_righe_nome_se_libera CHECK (site_id IS NOT NULL OR char_length(btrim(nome)) > 0)
);
CREATE INDEX IF NOT EXISTS lavagna_righe_company_idx ON lavagna_righe (company_id);
-- Solo il backend (service role) legge e scrive: RLS accesa, nessuna policy.
ALTER TABLE lavagna_righe ENABLE ROW LEVEL SECURITY;
