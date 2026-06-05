-- 095_studio_shared_docs.sql
-- Documenti condivisi dallo studio CDL con l'impresa cliente.
-- Il CDL carica un documento (es. lettera, accordo, avviso) e l'impresa lo vede
-- nella propria pagina Documenti Aziendali.

CREATE TABLE IF NOT EXISTS studio_shared_documents (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id    UUID        NOT NULL REFERENCES studio_partners(id) ON DELETE CASCADE,
  company_id   UUID        NOT NULL REFERENCES companies(id)        ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  description  TEXT,
  category     VARCHAR(50) NOT NULL DEFAULT 'altro',
  file_path    TEXT        NOT NULL,
  file_size    INTEGER,
  mime_type    VARCHAR(100),
  created_by   UUID        REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_studio_shared_docs_company ON studio_shared_documents(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_shared_docs_studio  ON studio_shared_documents(studio_id, created_at DESC);
