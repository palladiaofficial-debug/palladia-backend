-- Migration 026: storico chat IA (Pal) con progetti/cartelle
-- Ogni utente ha le proprie conversazioni, filtrate per company.
-- context_type 'azienda' = chat generale; 'cantiere' = chat contestuale a un sito.

-- ── Conversazioni ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_conversations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  user_id      uuid        NOT NULL,
  title        text        NOT NULL DEFAULT 'Nuova conversazione',
  context_type text        NOT NULL DEFAULT 'azienda'
                           CHECK (context_type IN ('azienda', 'cantiere')),
  context_id   uuid,       -- site_id quando context_type = 'cantiere'
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Messaggi ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid        NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role             text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ── Indici ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_chat_conversations_company_user
  ON chat_conversations(company_id, user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_context
  ON chat_conversations(company_id, context_type, context_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
  ON chat_messages(conversation_id, created_at ASC);

-- ── Trigger: aggiorna updated_at su ogni nuovo messaggio ─────────────────────
CREATE OR REPLACE FUNCTION _chat_conversation_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE chat_conversations
  SET updated_at = now()
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_messages_touch ON chat_messages;
CREATE TRIGGER trg_chat_messages_touch
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION _chat_conversation_touch();
