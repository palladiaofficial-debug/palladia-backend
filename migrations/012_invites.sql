-- Migration 012: Team invites
-- Inviti per aggiungere tecnici/admin alla company via email

CREATE TABLE IF NOT EXISTS company_invites (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email        TEXT        NOT NULL,
  role         TEXT        NOT NULL CHECK (role IN ('admin', 'tech', 'viewer')),
  token        TEXT        NOT NULL UNIQUE,
  invited_by   UUID        NOT NULL,  -- user_id di chi ha creato l'invito
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '48 hours',
  used_at      TIMESTAMPTZ,           -- NULL = ancora valido
  used_by      UUID                   -- user_id di chi ha accettato
);

-- Indice per lookup rapido del token (endpoint pubblico accept)
CREATE INDEX IF NOT EXISTS company_invites_token_idx ON company_invites(token);

-- Indice per listare gli inviti pendenti di una company
CREATE INDEX IF NOT EXISTS company_invites_company_idx ON company_invites(company_id, used_at);
