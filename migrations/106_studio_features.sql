-- ═══════════════════════════════════════════════════════════════════════════════
-- 106: Studio CDL — 5 nuove feature (alert configurabili, audit, permessi, ICS)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. Alert configurabili per studio ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_alert_config (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id     uuid        NOT NULL REFERENCES studio_partners(id) ON DELETE CASCADE,
  alert_type    text        NOT NULL,  -- cert_expiry|health_expiry|durc_expiry|dvr_age|riunione|safety_role
  warn_days     integer     NOT NULL DEFAULT 60,
  critical_days integer     NOT NULL DEFAULT 30,
  enabled       boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (studio_id, alert_type)
);

ALTER TABLE studio_alert_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY studio_alert_config_rw ON studio_alert_config FOR ALL
  USING (studio_id IN (SELECT studio_id FROM studio_users WHERE user_id = auth.uid()));

-- ── 2. Audit log azioni studio ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_audit_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid        NOT NULL REFERENCES studio_partners(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL,
  action      text        NOT NULL,   -- client.create|worker.update|cert.delete|durc.add|doc.upload|...
  company_id  uuid,                   -- impresa coinvolta (se applicabile)
  target_type text,                   -- worker|certificate|durc|document|...
  target_id   uuid,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_studio_audit_studio ON studio_audit_log(studio_id, created_at DESC);
CREATE INDEX idx_studio_audit_company ON studio_audit_log(company_id, created_at DESC);

ALTER TABLE studio_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY studio_audit_log_rw ON studio_audit_log FOR ALL
  USING (studio_id IN (SELECT studio_id FROM studio_users WHERE user_id = auth.uid()));

-- Trigger append-only (come presence_logs)
CREATE OR REPLACE FUNCTION _studio_audit_log_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'studio_audit_log is append-only: % not allowed', TG_OP;
END;
$$;

CREATE TRIGGER studio_audit_log_no_update
  BEFORE UPDATE ON studio_audit_log FOR EACH ROW
  EXECUTE FUNCTION _studio_audit_log_append_only();

CREATE TRIGGER studio_audit_log_no_delete
  BEFORE DELETE ON studio_audit_log FOR EACH ROW
  EXECUTE FUNCTION _studio_audit_log_append_only();

-- ── 3. Assegnazione collaboratori a clienti ─────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_user_clients (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid        NOT NULL REFERENCES studio_partners(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL,
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (studio_id, user_id, company_id)
);

CREATE INDEX idx_studio_user_clients_user ON studio_user_clients(user_id, studio_id);

ALTER TABLE studio_user_clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY studio_user_clients_rw ON studio_user_clients FOR ALL
  USING (studio_id IN (SELECT studio_id FROM studio_users WHERE user_id = auth.uid()));
