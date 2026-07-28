-- ─── 143_company_semaforo_snapshots.sql ───────────────────────────────────────
-- Layer "proof of value" — step 4: serve una foto mensile dello stato di
-- conformità (semaforo) per poter dire onestamente "migliorato/peggiorato
-- rispetto al mese scorso" nel report mensile. Senza uno storico non possiamo
-- calcolare una variazione — non la inventiamo, la registriamo da qui in poi.
--
-- Una riga per (company_id, snapshot_month): il cron mensile fa upsert del
-- mese corrente e legge il mese precedente per il confronto.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS company_semaforo_snapshots (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  snapshot_month date        NOT NULL,  -- primo giorno del mese rappresentato
  semaforo       text        NOT NULL CHECK (semaforo IN ('verde', 'giallo', 'rosso')),
  critical_count integer     NOT NULL DEFAULT 0,
  warning_count  integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, snapshot_month)
);

CREATE INDEX IF NOT EXISTS idx_semaforo_snapshots_company ON company_semaforo_snapshots(company_id, snapshot_month DESC);

ALTER TABLE company_semaforo_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "semaforo_snapshots_select_own" ON company_semaforo_snapshots;
CREATE POLICY "semaforo_snapshots_select_own"
  ON company_semaforo_snapshots FOR SELECT
  TO authenticated
  USING (is_company_member(company_id));

-- Nessuna policy INSERT/UPDATE per authenticated: scritto solo dal cron
-- mensile (service_role) via services/monthlyValueReport.js.
