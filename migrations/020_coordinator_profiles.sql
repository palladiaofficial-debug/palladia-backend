-- Migration 020 — Profili Professionisti
-- Tabella che persiste il profilo di un coordinatore/DL/RUP indipendentemente
-- dalle sessioni. Un professionista si registra una volta sola — il profilo
-- rimane anche quando le sessioni scadono.

CREATE TABLE IF NOT EXISTS coordinator_profiles (
  email      TEXT        PRIMARY KEY,
  full_name  TEXT        NOT NULL,
  qualifica  TEXT        NOT NULL DEFAULT 'Altro',
  azienda    TEXT,
  piva       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE coordinator_profiles IS
  'Profili professionisti esterni (CSE/CSP/DL/RUP) — persistono indipendentemente dalle sessioni.';

COMMENT ON COLUMN coordinator_profiles.qualifica IS
  'Ruolo professionale: CSE, CSP, Direttore Lavori, RUP, Altro';
