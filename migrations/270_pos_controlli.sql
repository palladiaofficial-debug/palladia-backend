-- F-427 (AUDIT.md del frontend): il POS di un'impresa in subappalto, controllato
-- dall'impresa principale prima di mandarlo al coordinatore (art. 97 c. 3-ter
-- D.Lgs. 81/2008). Un controllo per file del POS: i controlli di lib/psc/posVerify.js
-- (contenuti minimi, prescrizioni del PSC recepite, abilitazioni per le attrezzature)
-- e la decisione del titolare («Va bene così»).
CREATE TABLE IF NOT EXISTS pos_controlli (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id                     uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  subcontractor_id            uuid        NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  subcontractor_document_id   uuid        NOT NULL UNIQUE REFERENCES subcontractor_documents(id) ON DELETE CASCADE,
  esito                       text        NOT NULL CHECK (esito IN ('torna', 'non_torna')),
  controlli                   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  accettato_at                timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_controlli_cantiere ON pos_controlli (company_id, site_id);
ALTER TABLE pos_controlli ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
