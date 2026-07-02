-- Migration 120: Ladia — conferma reale lato server per scritture medium/high.
-- Prima la "conferma" era solo un bottone che rimandava testo alla chat: il
-- modello decideva di nuovo, di sua iniziativa, se scrivere. Questa tabella
-- rende la conferma vincolante — la scrittura vera avviene solo dopo un
-- decision esplicito dell'utente su un pending_action_id concreto.

CREATE TABLE IF NOT EXISTS ladia_pending_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  conversation_id UUID REFERENCES chat_conversations(id) ON DELETE SET NULL,
  operations      JSONB NOT NULL,
  summary         TEXT NOT NULL,
  sensitivity     TEXT NOT NULL CHECK (sensitivity IN ('medium', 'high')),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'executing', 'executed', 'rejected', 'expired', 'error')),
  result          JSONB,
  error_msg       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  decided_at      TIMESTAMPTZ,
  decided_by      UUID
);

CREATE INDEX IF NOT EXISTS idx_ladia_pending_actions_company ON ladia_pending_actions(company_id, status);

ALTER TABLE ladia_pending_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY ladia_pending_actions_company ON ladia_pending_actions
  FOR ALL USING (is_company_member(company_id));
