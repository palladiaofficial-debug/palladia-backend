-- Migration 014: aggiunge campi veicolo + tabella documenti equipment
-- 2026-05-20

-- Nuovi campi veicolo su equipment
ALTER TABLE equipment
  ADD COLUMN IF NOT EXISTS colore               text,
  ADD COLUMN IF NOT EXISTS anno_immatricolazione text,
  ADD COLUMN IF NOT EXISTS numero_telaio         text;

-- Tabella documenti allegati (libretto, assicurazione, ecc.)
CREATE TABLE IF NOT EXISTS equipment_documents (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id    uuid        NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  equipment_id  uuid        NOT NULL REFERENCES equipment(id)  ON DELETE CASCADE,
  doc_type      text        NOT NULL DEFAULT 'altro',  -- libretto|assicurazione|revisione|collaudo|altro
  file_name     text        NOT NULL,
  file_url      text,
  file_size     bigint,
  mime_type     text,
  ai_extracted  jsonb,
  uploaded_at   timestamptz DEFAULT now(),
  uploaded_by   uuid
);

CREATE INDEX IF NOT EXISTS equipment_documents_eq_idx      ON equipment_documents(equipment_id);
CREATE INDEX IF NOT EXISTS equipment_documents_company_idx ON equipment_documents(company_id);

ALTER TABLE equipment_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "equipment_documents_company_rw" ON equipment_documents
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

-- Storage bucket per i documenti
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'equipment-docs',
  'equipment-docs',
  false,
  10485760,
  ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']
)
ON CONFLICT DO NOTHING;

-- RLS storage: solo utenti autenticati, path = {company_id}/{equipment_id}/...
CREATE POLICY IF NOT EXISTS "equipment_docs_storage_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'equipment-docs');

CREATE POLICY IF NOT EXISTS "equipment_docs_storage_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'equipment-docs');

CREATE POLICY IF NOT EXISTS "equipment_docs_storage_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'equipment-docs');
