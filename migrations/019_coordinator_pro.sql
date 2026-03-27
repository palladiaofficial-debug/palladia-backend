-- Migration 019 — Portale Professionisti (CSE, CSP, DL, RUP)
-- Sessioni di accesso aggregate multi-cantiere per professionisti esterni.
-- Un professionista che riceve inviti da più imprese accede con la sua email
-- e vede tutti i cantieri in cui è registrato come coordinatore.

CREATE TABLE IF NOT EXISTS coordinator_pro_sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT        NOT NULL,
  token_hash   TEXT        UNIQUE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pro_sessions_email ON coordinator_pro_sessions(email);
CREATE INDEX IF NOT EXISTS idx_pro_sessions_token ON coordinator_pro_sessions(token_hash);

COMMENT ON TABLE coordinator_pro_sessions IS
  'Sessioni magic-link per professionisti esterni (CSE/CSP/DL/RUP) — accesso multi-cantiere.';
