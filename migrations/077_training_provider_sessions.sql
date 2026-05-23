-- Migration 077: Training Provider Sessions
-- Sessioni magiche per il portale enti formazione (simile a coordinator_pro_sessions)

CREATE TABLE IF NOT EXISTS training_provider_sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  UUID        NOT NULL REFERENCES training_providers(id) ON DELETE CASCADE,
  email        TEXT        NOT NULL,
  token_hash   TEXT        NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '365 days',
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_sessions_token    ON training_provider_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_provider_sessions_email    ON training_provider_sessions(email);
CREATE INDEX IF NOT EXISTS idx_provider_sessions_provider ON training_provider_sessions(provider_id);
