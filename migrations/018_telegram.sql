-- ============================================================
-- Migration 018 — Telegram Bot Integration
-- Tabelle: telegram_users, telegram_link_tokens, site_notes,
--          telegram_event_logs
--
-- NOTA BUCKET STORAGE:
--   Crea il bucket "site-media" come PRIVATO (non pubblico).
--   Le immagini vengono servite tramite signed URL temporanei (1h).
-- ============================================================

-- ── Tabella: utenti Telegram collegati a Palladia ────────────
CREATE TABLE IF NOT EXISTS telegram_users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id           UUID        NOT NULL,       -- auth.uid Supabase
  telegram_chat_id  BIGINT      NOT NULL UNIQUE,
  telegram_username TEXT,
  telegram_first_name TEXT,
  active_site_id    UUID        REFERENCES sites(id) ON DELETE SET NULL,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at    TIMESTAMPTZ
);

CREATE INDEX idx_telegram_users_chat_id  ON telegram_users(telegram_chat_id);
CREATE INDEX idx_telegram_users_company  ON telegram_users(company_id);
CREATE INDEX idx_telegram_users_user_id  ON telegram_users(user_id);

ALTER TABLE telegram_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company_members_telegram_users" ON telegram_users
  FOR ALL USING (is_company_member(company_id));

-- ── Tabella: token monouso per collegare account ─────────────
CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  token       TEXT        PRIMARY KEY,
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE INDEX idx_link_tokens_user ON telegram_link_tokens(user_id);

ALTER TABLE telegram_link_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_link_tokens" ON telegram_link_tokens
  FOR ALL USING (auth.uid() = user_id);

-- ── Tabella: note cantiere (da Telegram + future fonti web) ──
CREATE TABLE IF NOT EXISTS site_notes (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id              UUID        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  author_id            UUID,
  author_name          TEXT,
  source               TEXT        NOT NULL DEFAULT 'telegram'
                         CHECK (source IN ('telegram','web','api')),
  category             TEXT        NOT NULL DEFAULT 'nota'
                         CHECK (category IN (
                           'nota','foto','non_conformita','verbale',
                           'presenza','incidente','documento','altro'
                         )),
  content              TEXT,
  -- media_path: percorso relativo in Supabase Storage (bucket: site-media)
  -- NON è un URL pubblico. Usare signed URL via GET /api/v1/site-notes/:id/media
  media_path           TEXT,
  media_type           TEXT,                        -- image/jpeg, application/pdf, ecc.
  media_filename       TEXT,
  media_size_bytes     INTEGER,
  ai_summary           TEXT,
  ai_category          TEXT,
  urgency              TEXT        NOT NULL DEFAULT 'normale'
                         CHECK (urgency IN ('normale','alta','critica')),
  telegram_message_id  BIGINT,
  telegram_chat_id     BIGINT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_site_notes_site      ON site_notes(site_id, created_at DESC);
CREATE INDEX idx_site_notes_company   ON site_notes(company_id);
CREATE INDEX idx_site_notes_category  ON site_notes(site_id, category);
CREATE INDEX idx_site_notes_urgency   ON site_notes(site_id, urgency) WHERE urgency != 'normale';
CREATE INDEX idx_site_notes_tg_dedup  ON site_notes(telegram_message_id) WHERE telegram_message_id IS NOT NULL;

ALTER TABLE site_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company_members_site_notes" ON site_notes
  FOR ALL USING (is_company_member(company_id));

-- ── Tabella: log eventi Telegram (audit trail) ───────────────
-- Traccia ogni messaggio ricevuto e ogni risposta inviata.
-- Non contiene dati sensibili completi — solo preview (200 char).
CREATE TABLE IF NOT EXISTS telegram_event_logs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID        REFERENCES companies(id) ON DELETE SET NULL,
  telegram_chat_id BIGINT,
  direction        TEXT        NOT NULL CHECK (direction IN ('inbound','outbound')),
  message_type     TEXT,       -- text|photo|document|voice|command|callback|system
  content_preview  TEXT,       -- max 200 char, no PII
  media_path       TEXT,
  site_id          UUID        REFERENCES sites(id) ON DELETE SET NULL,
  status           TEXT        NOT NULL DEFAULT 'ok'
                     CHECK (status IN ('ok','error','ignored','rate_limited')),
  error_msg        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tg_event_logs_chat    ON telegram_event_logs(telegram_chat_id, created_at DESC);
CREATE INDEX idx_tg_event_logs_company ON telegram_event_logs(company_id, created_at DESC);
CREATE INDEX idx_tg_event_logs_status  ON telegram_event_logs(status) WHERE status != 'ok';

ALTER TABLE telegram_event_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company_members_tg_logs" ON telegram_event_logs
  FOR SELECT USING (is_company_member(company_id));
-- Solo lettura via RLS — insert avviene solo da service_role (backend)
