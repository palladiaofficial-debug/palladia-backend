-- 238 — F-270, seconda parte: accettazione del PSC da parte delle imprese
-- (art. 100 c.5 e art. 102), segnalazioni al committente e all'ASL (art. 92
-- c.1 lett. e), cantiere di esempio. Tocca solo tabelle psc_*.

ALTER TABLE psc_imprese
  ADD COLUMN IF NOT EXISTS psc_accettato_rev  integer,
  ADD COLUMN IF NOT EXISTS psc_accettato_at   timestamptz,
  ADD COLUMN IF NOT EXISTS psc_accettato_da   text,
  ADD COLUMN IF NOT EXISTS rls_consultato     boolean,
  ADD COLUMN IF NOT EXISTS psc_proposte       text;

ALTER TABLE psc_projects
  ADD COLUMN IF NOT EXISTS esempio boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS psc_segnalazioni (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        NOT NULL REFERENCES psc_projects(id) ON DELETE CASCADE,
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  impresa_id    uuid        REFERENCES psc_imprese(id) ON DELETE SET NULL,
  destinatario  text        NOT NULL CHECK (destinatario IN ('committente', 'asl')),
  proposta      text        CHECK (proposta IN ('sospensione', 'allontanamento', 'risoluzione')),
  nc_ids        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  testo         text        NOT NULL,
  pdf_path      text,
  email_to      text,
  sent_at       timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS psc_segnalazioni_project ON psc_segnalazioni (project_id, created_at DESC);
ALTER TABLE psc_segnalazioni ENABLE ROW LEVEL SECURITY;
