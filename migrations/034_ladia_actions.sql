'use strict';
-- ============================================================
-- Migration 034 — Ladia Actions
--
-- 1. Aggiunge resolved_at / resolved_by a site_notes
--    → permette a Ladia di chiudere NC via Telegram (un tap)
--
-- 2. Crea ladia_action_log
--    → traccia ogni azione confermata dall'utente via bottone
-- ============================================================

-- 1. Campi risoluzione su site_notes (nullable → backwards compat)
ALTER TABLE site_notes
  ADD COLUMN IF NOT EXISTS resolved_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by  TEXT;
  -- resolved_by: "telegram:<chat_id>" oppure "web:<user_id>"

-- Indice parziale: query NC aperte (category + NOT resolved)
CREATE INDEX IF NOT EXISTS idx_site_notes_nc_open
  ON site_notes (site_id, urgency, created_at)
  WHERE category = 'non_conformita' AND resolved_at IS NULL;

-- 2. Tabella ladia_action_log
CREATE TABLE IF NOT EXISTS ladia_action_log (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID         REFERENCES companies(id) ON DELETE SET NULL,
  site_id       UUID         REFERENCES sites(id)     ON DELETE SET NULL,
  chat_id       TEXT         NOT NULL,
  action_type   TEXT         NOT NULL,
  -- close_nc | reg_exits | rain_notify | expiry_remind
  -- skip_nc  | skip_exits | rain_skip  | expiry_skip
  -- budget_ladia | open_ladia | skip_inactive
  action_params JSONB        NOT NULL DEFAULT '{}',
  result        TEXT         NOT NULL DEFAULT 'ok'
                  CHECK (result IN ('ok', 'error', 'skipped')),
  error_msg     TEXT,
  executed_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ladia_action_log_chat
  ON ladia_action_log (chat_id, executed_at DESC);

CREATE INDEX IF NOT EXISTS idx_ladia_action_log_company
  ON ladia_action_log (company_id, executed_at DESC);

-- RLS: i member della company vedono il log delle proprie azioni
ALTER TABLE ladia_action_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ladia_action_log_select" ON ladia_action_log
  FOR SELECT USING (is_company_member(company_id));
