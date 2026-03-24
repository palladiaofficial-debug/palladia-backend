-- Migration 016: Documenti di sicurezza per cantiere
-- Ogni documento ha un file fisico su Supabase Storage (bucket: site-documents)

CREATE TABLE IF NOT EXISTS site_documents (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  site_id      uuid        NOT NULL REFERENCES sites(id)      ON DELETE CASCADE,
  name         text        NOT NULL CHECK (length(trim(name)) > 0),
  category     text        NOT NULL DEFAULT 'altro'
               CHECK (category IN ('pos','psc','notifica_asl','durc','dvr','assicurazione','altro')),
  file_path    text        NOT NULL,
  file_size    bigint,
  mime_type    text,
  uploaded_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_docs_site    ON site_documents(site_id);
CREATE INDEX IF NOT EXISTS idx_site_docs_company ON site_documents(company_id);
