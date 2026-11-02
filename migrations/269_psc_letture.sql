-- F-426 (AUDIT.md del frontend): il PSC del cantiere letto una volta sola.
-- La lettura (lib/pscExtract.js: committente, coordinatori, fasi, le richieste
-- del PSC alla tua impresa con la pagina) si salva qui per il file del PSC: la
-- usano la pagina «Il PSC del coordinatore», la catena della sicurezza, Oggi e il
-- POS rapido, senza rileggere il documento con l'IA a ogni apertura.
CREATE TABLE IF NOT EXISTS psc_letture (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id           uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  site_document_id  uuid        NOT NULL UNIQUE REFERENCES site_documents(id) ON DELETE CASCADE,
  dati              jsonb       NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS psc_letture_cantiere ON psc_letture (company_id, site_id, created_at DESC);
ALTER TABLE psc_letture ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
