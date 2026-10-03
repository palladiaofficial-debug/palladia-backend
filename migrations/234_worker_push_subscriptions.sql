-- 234 — Notifiche push agli operai (F-267, AUDIT.md del frontend)
-- Il badge chiedeva il permesso per le notifiche ma salvava l'iscrizione su
-- una rotta che richiede il login dell'app (401): nessun operaio è mai stato
-- iscritto. Tabella SEPARATA da push_subscriptions di proposito:
-- sendPushToCompany manda lì gli avvisi dell'ufficio a tutti gli iscritti
-- dell'azienda, e un operaio non deve riceverli.
CREATE TABLE IF NOT EXISTS worker_push_subscriptions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_id   uuid        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  endpoint    text        NOT NULL UNIQUE,
  p256dh      text        NOT NULL,
  auth        text        NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_push_subscriptions_worker ON worker_push_subscriptions (worker_id);
-- Solo il backend (service role) la legge e la scrive: nessuna policy per i client.
ALTER TABLE worker_push_subscriptions ENABLE ROW LEVEL SECURITY;
