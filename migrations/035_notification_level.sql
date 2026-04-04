-- Migration 035 — Notification Level & Interaction Tracking
--
-- 1. notification_level su telegram_users
--    quiet    → solo briefing mattutino e serale, zero alert durante il giorno
--    balanced → alert aggregati per sito (default)
--    full     → massima reattività, comportamento identico a balanced (label futura)
--
-- 2. last_interaction_at → timestamp ultimo tap su un bottone inline
--    Usato da Ladia per rilevare la "fatica da notifiche" e passare
--    automaticamente a quiet dopo 3 giorni senza interazione.

ALTER TABLE telegram_users
  ADD COLUMN IF NOT EXISTS notification_level TEXT NOT NULL DEFAULT 'balanced'
    CHECK (notification_level IN ('quiet', 'balanced', 'full')),
  ADD COLUMN IF NOT EXISTS last_interaction_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_telegram_users_notification
  ON telegram_users (notification_level, last_interaction_at);
