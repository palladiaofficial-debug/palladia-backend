-- 235 — Timbrature da sistemare (mockup approvato il 2026-10-03, dopo F-266)
-- Un caso per riga, con la proposta già pronta: il titolare la conferma con
-- un tocco (o sceglie un altro orario) da Da fare. Non tocca presence_logs:
-- la correzione, quando confermata, è una riga admin_manual_correction (o
-- un'annotazione) come quelle fatte a mano da Presenze → Correzione manuale.
--   missing_exit    entrata aperta oltre l'orario abituale, promemoria senza risposta
--   forgot_entry    primo tocco nel pomeriggio: "sto andando via, ho dimenticato l'entrata"
--   entry_not_exit  dopo un turno di pochi minuti: "sto andando via" (F-266)
--   short_shift     turno di pochi minuti confermato dall'operaio (F-266)
CREATE TABLE IF NOT EXISTS presence_fix_requests (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_id     uuid        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id       uuid,
  kind          text        NOT NULL CHECK (kind IN ('missing_exit', 'forgot_entry', 'entry_not_exit', 'short_shift')),
  day           date        NOT NULL,
  entry_log_id  uuid,
  exit_log_id   uuid,
  entry_at      timestamptz,
  exit_at       timestamptz,
  touch_at      timestamptz,
  proposed_at   timestamptz,
  status        text        NOT NULL DEFAULT 'aperta' CHECK (status IN ('aperta', 'risolta', 'ignorata')),
  resolved_by   uuid,
  resolved_at   timestamptz,
  resolution    jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Un solo caso per lavoratore, tipo e giorno: un doppio tocco o un cron che
-- riparte non creano doppioni.
CREATE UNIQUE INDEX IF NOT EXISTS presence_fix_requests_one_per_day ON presence_fix_requests (worker_id, kind, day);
CREATE INDEX IF NOT EXISTS presence_fix_requests_open ON presence_fix_requests (company_id, status);
ALTER TABLE presence_fix_requests ENABLE ROW LEVEL SECURITY;

-- Promemoria e avvisi già mandati (cron uscite): niente doppioni tra un giro e l'altro.
CREATE TABLE IF NOT EXISTS presence_reminders (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_id     uuid        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  entry_log_id  uuid        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('exit_reminder', 'exit_owner_alert')),
  sent_at       timestamptz NOT NULL DEFAULT now(),
  pushed        integer     NOT NULL DEFAULT 0,
  UNIQUE (entry_log_id, kind)
);
ALTER TABLE presence_reminders ENABLE ROW LEVEL SECURITY;
