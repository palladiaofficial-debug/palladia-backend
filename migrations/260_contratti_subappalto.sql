-- 260 — F-398 (AUDIT.md del frontend): il contratto di subappalto come percorso
-- a sé, da Imprese › scheda › «Fai il contratto» («dobbiamo raggiungere un
-- livello altissimo per i contratti… far scegliere le clausole con pochi click…
-- per i dati basta caricare la visura», il titolare, 28/10).
-- Chi firma: si scrive una volta e resta (azienda e impresa in subappalto).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS legale_rappresentante text;
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS legale_rappresentante text;
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS codice_fiscale text;
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS rea text;
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS pec text;

-- Ogni contratto fatto resta: con quali dati e quali clausole, e il PDF.
CREATE TABLE IF NOT EXISTS contratti_subappalto (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subcontractor_id  uuid NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  site_id           uuid REFERENCES sites(id) ON DELETE SET NULL,
  dati              jsonb NOT NULL,
  clausole          jsonb NOT NULL,
  file_path         text NOT NULL,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contratti_subappalto_impresa ON contratti_subappalto (company_id, subcontractor_id, created_at DESC);
-- Solo il backend (service role) legge e scrive: nessuna policy per gli utenti.
ALTER TABLE contratti_subappalto ENABLE ROW LEVEL SECURITY;
