-- Migration 027: Telegram per coordinatori professionisti
-- Permette ai coordinatori del Portale Pro di collegare il loro Telegram
-- e inviare note/foto di cantiere direttamente dalla chat Telegram.

-- ── Codici OTP temporanei per il collegamento ────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_coordinator_link_codes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text        NOT NULL,
  code       text        NOT NULL UNIQUE,   -- 8 char uppercase
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  used_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_tg_coord_codes_code  ON telegram_coordinator_link_codes(code);
CREATE INDEX IF NOT EXISTS idx_tg_coord_codes_email ON telegram_coordinator_link_codes(email, expires_at);

-- ── Coordinatori collegati (persistente) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_coordinator_links (
  telegram_chat_id bigint      PRIMARY KEY,
  email            text        NOT NULL REFERENCES coordinator_profiles(email) ON DELETE CASCADE,
  telegram_username text,
  telegram_name    text,
  active_site_id   uuid,       -- cantiere attivo selezionato via bot
  linked_at        timestamptz NOT NULL DEFAULT now(),
  last_active_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_tg_coord_links_email ON telegram_coordinator_links(email);

-- ── Pulizia automatica dei codici scaduti ────────────────────────────────────
CREATE OR REPLACE FUNCTION _cleanup_telegram_coord_codes()
RETURNS void LANGUAGE sql AS $$
  DELETE FROM telegram_coordinator_link_codes
  WHERE expires_at < now() - interval '1 hour';
$$;
