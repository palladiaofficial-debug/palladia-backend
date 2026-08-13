-- 159_ai_spend_alerts.sql
-- Dedup durevole per il circuit breaker sulla spesa AI giornaliera dell'intera
-- piattaforma (lib/ladiaUsageLog.js). Una riga per giorno solare (Europe/Rome):
-- il primo processo che supera la soglia vince l'INSERT (UNIQUE su alert_date)
-- e manda l'allerta; eventuali altri processi/istanze Railway che rieseguono
-- lo stesso controllo nello stesso giorno falliscono l'INSERT per conflitto e
-- non rimandano l'email — necessario perché il debounce non può vivere solo in
-- memoria di processo (più istanze, riavvii). Nessuna colonna company_id: non
-- è un dato di un singolo cliente, è uno stato operativo interno.

CREATE TABLE IF NOT EXISTS ai_spend_alerts (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_date          date          NOT NULL UNIQUE,
  total_spend_usd     numeric(10,2) NOT NULL,
  external_spend_usd  numeric(10,2) NOT NULL,
  threshold_usd       numeric(10,2) NOT NULL,
  created_at          timestamptz   NOT NULL DEFAULT now()
);

-- RLS abilitata senza nessuna policy: tabella letta/scritta solo dal backend
-- con service role (bypassa RLS), mai da una sessione utente autenticata —
-- stesso schema di "solo service_role" già usato per admin_audit_log (006).
ALTER TABLE ai_spend_alerts ENABLE ROW LEVEL SECURITY;
