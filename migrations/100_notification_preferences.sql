-- Migration 100: Preferenze notifiche per utente
-- Ogni tecnico/admin/owner può disattivare singoli canali di notifica.

CREATE TABLE IF NOT EXISTS notification_preferences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  email_enabled   boolean NOT NULL DEFAULT true,
  telegram_enabled boolean NOT NULL DEFAULT true,
  push_enabled    boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id)
);

CREATE INDEX idx_notification_preferences_company ON notification_preferences(company_id);
CREATE INDEX idx_notification_preferences_user    ON notification_preferences(user_id);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own notification preferences"
  ON notification_preferences FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notification preferences"
  ON notification_preferences FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own notification preferences"
  ON notification_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- service_role bypassa RLS, quindi i cron possono leggere le preferenze di tutti.
