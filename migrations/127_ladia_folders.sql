-- Migration 127: cartelle per organizzare le conversazioni Ladia
-- Prima erano salvate solo in localStorage del browser: sparivano cambiando
-- dispositivo o browser. Le spostiamo lato DB, per-utente/per-company, così
-- restano identiche ovunque l'utente acceda.

CREATE TABLE IF NOT EXISTS ladia_folders (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL,
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ladia_folders_company_user
  ON ladia_folders(company_id, user_id);

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES ladia_folders(id) ON DELETE SET NULL;
