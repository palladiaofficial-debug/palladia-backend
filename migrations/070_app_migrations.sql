-- 070_app_migrations.sql
-- Tabella guard per migrazioni one-shot eseguite a runtime (server startup).
-- Usata da services/formazioneMigration.js e future migrazioni simili.

CREATE TABLE IF NOT EXISTS app_migrations (
  key        text PRIMARY KEY,
  ran_at     timestamptz NOT NULL DEFAULT now(),
  meta       jsonb
);
