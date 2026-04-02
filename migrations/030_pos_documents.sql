-- Migration 030: tabella pos_documents
-- Salva i POS generati collegati ai cantieri, consultabili in lista.

CREATE TABLE IF NOT EXISTS pos_documents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  site_id     uuid        NOT NULL REFERENCES sites(id)      ON DELETE CASCADE,
  revision    integer     NOT NULL DEFAULT 1,
  created_by  uuid,       -- user_id di chi ha generato
  pos_data    jsonb,      -- dati completi del modulo POS
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_documents_site    ON pos_documents(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_documents_company ON pos_documents(company_id, created_at DESC);
