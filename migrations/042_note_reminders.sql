-- Migration 042 — Promemoria note cantiere via Telegram
-- Ogni riga = un promemoria schedulato. Il cron invia e marca sent_at.

CREATE TABLE IF NOT EXISTS site_note_reminders (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  note_id     UUID        NOT NULL REFERENCES site_notes(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL,
  chat_id     BIGINT      NOT NULL,
  note_text   TEXT        NOT NULL,
  send_at     TIMESTAMPTZ NOT NULL,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index per il cron: cerca solo i pending con send_at imminente
CREATE INDEX IF NOT EXISTS idx_note_reminders_pending
  ON site_note_reminders (send_at)
  WHERE sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_note_reminders_user
  ON site_note_reminders (user_id, created_at DESC);
