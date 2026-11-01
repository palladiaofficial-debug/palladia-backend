-- F-421 (AUDIT.md del frontend): «Pronta a lavorare», fase 3 — tu, quando lavori per un'altra impresa.

-- I documenti della TUA impresa che servono per fare da subappalto: la patente a crediti,
-- la dichiarazione di non essere sospesa (art. 14), l'attestazione SOA.
-- Stesso elenco di prima (migrazioni 049 e 167, lib/documentCategory.js) più le tre nuove.
ALTER TABLE company_documents DROP CONSTRAINT IF EXISTS company_docs_category_check;
ALTER TABLE company_documents ADD CONSTRAINT company_docs_category_check CHECK (
  category IN (
    'rspp', 'rls', 'medico_competente', 'visite_mediche',
    'primo_soccorso', 'emergenze', 'preposto',
    'dvr', 'duvri', 'formazione',
    'durc', 'visura', 'iso', 'soa',
    'assicurazione', 'polizza', 'f24',
    'contratto', 'capitolato',
    'patente_crediti', 'dichiarazione_art14',
    'altro'
  )
);

-- La SOA della tua impresa: classe III o più esenta dalla patente a crediti
ALTER TABLE companies ADD COLUMN IF NOT EXISTS soa_classifica text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS soa_expiry date;

-- Il link con i tuoi documenti per l'impresa che ti prende: uno per impresa e cantiere.
-- Nel DB solo l'hash del token (come sub_link); si vede solo dal server.
CREATE TABLE IF NOT EXISTS pacchetti_documenti (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token_hash    text        NOT NULL UNIQUE,
  destinatario  text        NOT NULL,
  cantiere      text,
  operai        uuid[]      NOT NULL DEFAULT '{}',
  pos_path      text,
  pos_mime      text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  aperto_at     timestamptz,
  spento_at     timestamptz
);
CREATE INDEX IF NOT EXISTS pacchetti_documenti_azienda ON pacchetti_documenti (company_id, created_at DESC);
ALTER TABLE pacchetti_documenti ENABLE ROW LEVEL SECURITY;
