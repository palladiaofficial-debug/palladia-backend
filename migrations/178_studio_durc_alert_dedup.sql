-- ─── 178_studio_durc_alert_dedup.sql ──────────────────────────────────────────
-- F-087 (AUDIT.md, BLOCCO 4): services/studioDurcAlertCron.js inviava una email
-- reale identica ALLO STESSO studio, per LO STESSO cliente, OGNI GIORNO in cui
-- il DURC restava entro la finestra di 30 giorni — nessuna condizione lower-bound
-- sulla query (`lte(t30)`), quindi anche un DURC scaduto da mesi e mai rinnovato
-- continuava a generare un'email quotidiana all'infinito. A differenza degli
-- altri cron di scadenza (workerExpiryCron, companyDocExpiryCron, ecc.) che
-- passano tutti da expiryHelper.upsertNotification()/shouldSendTelegram() per
-- evitare notifiche duplicate, questo cron non aveva alcun meccanismo di dedup.
--
-- Questa tabella applica lo stesso pattern (isNew / escalated / critical-sempre)
-- a livello (studio_id, company_id), così l'email digest viene filtrata alle
-- sole aziende che hanno davvero qualcosa di nuovo da segnalare oggi.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS studio_durc_alert_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id    uuid        NOT NULL REFERENCES studio_partners(id) ON DELETE CASCADE,
  company_id   uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  severity     text        NOT NULL CHECK (severity IN ('info','warning','critical')),
  notified_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_durc_alert_log_pair
  ON studio_durc_alert_log (studio_id, company_id);

ALTER TABLE studio_durc_alert_log ENABLE ROW LEVEL SECURITY;

-- Nessuna policy per authenticated/anon: scritto e letto solo dal cron via
-- service_role (stesso pattern di expiry_interception_log, migrazione 141).
