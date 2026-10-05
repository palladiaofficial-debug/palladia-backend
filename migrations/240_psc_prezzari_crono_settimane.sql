-- 240 — F-293 / F-298 (AUDIT.md del frontend)
-- Prezzari caricati dai coordinatori (quello della Liguria, sezione Sicurezza,
-- è incluso in Palladia come file dati e non sta qui) e cronoprogramma a
-- settimane, come lo pianificano i coordinatori quando le date esatte non si
-- possono prevedere.

CREATE TABLE IF NOT EXISTS psc_prezzario_voci (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fonte         text        NOT NULL,
  codice        text        NOT NULL,
  descrizione   text        NOT NULL,
  um            text,
  prezzo        numeric(14,2) NOT NULL,
  capitolo      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fonte, codice)
);
CREATE INDEX IF NOT EXISTS psc_prezzario_voci_company ON psc_prezzario_voci (company_id, fonte);
ALTER TABLE psc_prezzario_voci ENABLE ROW LEVEL SECURITY;

-- Da quale prezzario viene il prezzo di una voce di costo (per il PDF)
ALTER TABLE psc_costi ADD COLUMN IF NOT EXISTS prezzario_fonte text;

-- Cronoprogramma: per settimane (default) o per giorni
ALTER TABLE psc_projects ADD COLUMN IF NOT EXISTS crono_scala text NOT NULL DEFAULT 'settimane';
DO $$ BEGIN
  ALTER TABLE psc_projects ADD CONSTRAINT psc_projects_crono_scala_check CHECK (crono_scala IN ('settimane', 'giorni'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
