-- 108_safety_copilot.sql
-- Tabella per storicizzare i Risk Score del Safety Copilot.
-- Ogni record = un calcolo orario del risk score di un cantiere.
-- Usato per: dashboard a semaforo, trend nel tempo, alert predittivi.

CREATE TABLE IF NOT EXISTS site_risk_scores (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id     uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  score       smallint NOT NULL CHECK (score >= 0 AND score <= 100),
  level       text NOT NULL CHECK (level IN ('verde', 'giallo', 'rosso')),
  dimensions  jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- Indice per query dashboard (ultimo score per cantiere)
CREATE INDEX IF NOT EXISTS idx_risk_scores_site_computed
  ON site_risk_scores (site_id, computed_at DESC);

-- Indice per query company-wide (tutti i cantieri di una company)
CREATE INDEX IF NOT EXISTS idx_risk_scores_company_computed
  ON site_risk_scores (company_id, computed_at DESC);

-- Indice per cleanup storico (pulizia record vecchi)
CREATE INDEX IF NOT EXISTS idx_risk_scores_computed_at
  ON site_risk_scores (computed_at);

-- RLS
ALTER TABLE site_risk_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company members can read risk scores"
  ON site_risk_scores FOR SELECT
  USING (is_company_member(company_id));

CREATE POLICY "Service role can insert risk scores"
  ON site_risk_scores FOR INSERT
  WITH CHECK (true);

-- Cleanup automatico: rimuovi record più vecchi di 90 giorni
-- (opzionale — da schedulare con pg_cron o applicativo)
COMMENT ON TABLE site_risk_scores IS
  'Safety Copilot — storico risk score per cantiere. Record ogni ora durante orario lavorativo.';
