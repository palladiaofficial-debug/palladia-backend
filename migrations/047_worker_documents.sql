-- Migration 047: archivio documenti del lavoratore
-- Ogni documento ha tipo, nome, date emissione/scadenza e URL file opzionale.
-- idoneita_medica e formazione_sicurezza sincronizzano automaticamente i campi
-- health_fitness_expiry / safety_training_expiry su workers (gestito dal backend).

CREATE TABLE IF NOT EXISTS worker_documents (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   uuid        NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  worker_id    uuid        NOT NULL REFERENCES workers(id)    ON DELETE CASCADE,
  doc_type     text        NOT NULL DEFAULT 'altro',
  name         text        NOT NULL,
  issued_date  date,
  expiry_date  date,
  file_url     text,
  notes        text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_worker_docs_worker  ON worker_documents(worker_id);
CREATE INDEX IF NOT EXISTS idx_worker_docs_company ON worker_documents(company_id);
CREATE INDEX IF NOT EXISTS idx_worker_docs_expiry  ON worker_documents(expiry_date)
  WHERE expiry_date IS NOT NULL;

ALTER TABLE worker_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "worker_docs_company_member"
  ON worker_documents FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));
