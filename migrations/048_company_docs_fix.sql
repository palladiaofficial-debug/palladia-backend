-- Migration 048: crea company_documents se non esiste, aggiorna constraint categorie, abilita RLS

CREATE TABLE IF NOT EXISTS company_documents (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  category    TEXT        NOT NULL DEFAULT 'altro',
  file_path   TEXT        NOT NULL,
  file_size   BIGINT,
  mime_type   TEXT,
  uploaded_by UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_docs_company
  ON company_documents (company_id, created_at DESC);

-- Aggiorna il constraint categorie (idempotente: drop + add)
ALTER TABLE company_documents DROP CONSTRAINT IF EXISTS company_docs_category_check;
ALTER TABLE company_documents ADD CONSTRAINT company_docs_category_check CHECK (
  category IN (
    'durc', 'visura', 'dvr', 'iso', 'soa',
    'assicurazione', 'f24', 'polizza', 'duvri', 'formazione', 'altro'
  )
);

-- RLS
ALTER TABLE company_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company_docs_member" ON company_documents;
CREATE POLICY "company_docs_member"
  ON company_documents FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));
