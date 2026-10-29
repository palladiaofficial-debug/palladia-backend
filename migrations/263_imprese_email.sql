-- 263 — F-410 (AUDIT.md del frontend): l'indirizzo email per i documenti
-- delle imprese («i subappaltatori mandano tutti i doc insieme per email»,
-- il titolare, 29/10). Ogni azienda ha documenti-{nome}-{codice}@palladia.net:
-- gli allegati diventano un caricamento F-401 che il titolare guarda e salva.
-- Solo il backend (service role) legge e scrive: RLS accesa, nessuna policy.

CREATE TABLE IF NOT EXISTS imprese_email_indirizzi (
  company_id  uuid        PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  token       text        NOT NULL UNIQUE,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE imprese_email_indirizzi ENABLE ROW LEVEL SECURITY;

-- Da dove arriva un caricamento: a mano o da un'email (con mittente e oggetto)
ALTER TABLE imprese_caricamenti ADD COLUMN IF NOT EXISTS origine text NOT NULL DEFAULT 'manuale';
ALTER TABLE imprese_caricamenti DROP CONSTRAINT IF EXISTS imprese_caricamenti_origine_check;
ALTER TABLE imprese_caricamenti ADD CONSTRAINT imprese_caricamenti_origine_check CHECK (origine IN ('manuale', 'email'));
ALTER TABLE imprese_caricamenti ADD COLUMN IF NOT EXISTS email_da text;
ALTER TABLE imprese_caricamenti ADD COLUMN IF NOT EXISTS email_oggetto text;
CREATE INDEX IF NOT EXISTS imprese_caricamenti_email_aperti ON imprese_caricamenti (company_id, created_at DESC) WHERE origine = 'email' AND salvato_at IS NULL;
