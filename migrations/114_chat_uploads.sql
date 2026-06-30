-- migration 114: chat_uploads — file temporanei caricati in chat Ladia

CREATE TABLE IF NOT EXISTS chat_uploads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL,
  user_id       UUID NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  size_bytes    INTEGER,
  archived      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_uploads_company ON chat_uploads(company_id);
CREATE INDEX IF NOT EXISTS idx_chat_uploads_created ON chat_uploads(created_at);
