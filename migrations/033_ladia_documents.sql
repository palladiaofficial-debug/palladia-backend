-- Migration 033: Ladia Document Templates
-- Documenti caricati via Telegram in modalità Ladia.
-- Ladia legge, analizza e memorizza questi documenti come riferimento
-- per generare nuovi documenti simili (contratti, capitolati, POS, ecc.).

CREATE TABLE IF NOT EXISTS ladia_document_templates (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  uploaded_by_chat_id  TEXT        NOT NULL,
  document_type        TEXT        NOT NULL DEFAULT 'altro'
                         CHECK (document_type IN (
                           'contratto', 'capitolato', 'POS', 'PSC',
                           'computo', 'fattura', 'verbale', 'preventivo',
                           'lettera', 'relazione', 'altro'
                         )),
  original_filename    TEXT,
  -- Riassunto generato da Claude (2-3 frasi)
  summary              TEXT,
  -- Sezioni chiave estratte [{titolo, contenuto}] — usate da Ladia come riferimento
  key_sections         JSONB       NOT NULL DEFAULT '[]',
  -- Testo principale estratto (max ~20k chars) — per ricerche e generazione
  extracted_text       TEXT,
  -- Path nel bucket Supabase Storage (site-documents)
  storage_path         TEXT,
  file_size_bytes      INTEGER,
  page_count           INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ladia_doc_templates_company_idx
  ON ladia_document_templates (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ladia_doc_templates_type_idx
  ON ladia_document_templates (company_id, document_type);
