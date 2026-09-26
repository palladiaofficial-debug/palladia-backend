-- 230 — Riepilogo unico delle 7:30 (F-240, Le quattro porte passo 4)
--
-- alert_digest_queue: i messaggi che gli automatismi del mattino (documenti,
--   mezzi, documenti aziendali, suolo pubblico, compleanni) mandavano subito su
--   Telegram e notifiche dell'app. Con il riepilogo acceso vengono messi qui;
--   se il riepilogo delle 7:30 va a buon fine restano solo come traccia, se
--   fallisce o non parte vengono spediti così come sono (rete di sicurezza).
-- alert_digest_runs: un giro al giorno per azienda — permette al controllo
--   delle 7:50 di sapere se il riepilogo è partito.
-- da_fare_digest_sent: quali righe di Da fare sono già state comunicate, così
--   il riepilogo dice solo le novità ("una volta sola", come da mockup).

CREATE TABLE IF NOT EXISTS alert_digest_queue (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind           text        NOT NULL,
  telegram_text  text,
  push           jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at   timestamptz,
  delivered_via  text        CHECK (delivered_via IN ('digest', 'fallback'))
);
CREATE INDEX IF NOT EXISTS idx_alert_digest_queue_pending
  ON alert_digest_queue (company_id, created_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS alert_digest_runs (
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_date    date        NOT NULL,
  status      text        NOT NULL CHECK (status IN ('sent', 'empty', 'failed')),
  items       integer     NOT NULL DEFAULT 0,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, run_date)
);

CREATE TABLE IF NOT EXISTS da_fare_digest_sent (
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id     text        NOT NULL,
  sent_on     date        NOT NULL,
  PRIMARY KEY (company_id, item_id)
);

-- Solo il backend (service role) scrive e legge queste tabelle.
ALTER TABLE alert_digest_queue  ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_digest_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE da_fare_digest_sent ENABLE ROW LEVEL SECURITY;
