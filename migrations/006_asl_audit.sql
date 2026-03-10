-- Migration 006: ASL access tokens + Admin audit log
-- Eseguire in Supabase SQL editor.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. asl_access_tokens
--    Link temporanei firmati per ispettori ASL / tecnici esterni.
--    Non richiedono login aziendale; accesso limitato a un cantiere + periodo.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asl_access_tokens (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id      uuid        NOT NULL REFERENCES sites(id)    ON DELETE CASCADE,
  token_hash   text        NOT NULL UNIQUE,   -- SHA-256 del token raw (mai salvare il raw)
  label        text        NOT NULL DEFAULT '',             -- es. "ASL Milano – Ispezione Aprile"
  from_date    date        NOT NULL,
  to_date      date        NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_by   uuid,                          -- auth.uid() dell'admin che ha generato il link
  used_count   int         NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (from_date <= to_date)
);

CREATE INDEX IF NOT EXISTS idx_asl_tokens_site    ON asl_access_tokens(site_id);
CREATE INDEX IF NOT EXISTS idx_asl_tokens_company ON asl_access_tokens(company_id);
CREATE INDEX IF NOT EXISTS idx_asl_tokens_hash    ON asl_access_tokens(token_hash);

-- RLS: solo i membri della company gestiscono i propri token
ALTER TABLE asl_access_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "asl_tokens_company_select" ON asl_access_tokens
  FOR SELECT USING (is_company_member(company_id));

CREATE POLICY "asl_tokens_company_insert" ON asl_access_tokens
  FOR INSERT WITH CHECK (is_company_member(company_id));

CREATE POLICY "asl_tokens_company_update" ON asl_access_tokens
  FOR UPDATE USING (is_company_member(company_id));

-- Funzione RPC per incrementare used_count in modo atomico (usata da asl.js)
CREATE OR REPLACE FUNCTION increment_asl_usage(p_token_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE asl_access_tokens
  SET used_count   = used_count + 1,
      last_used_at = now()
  WHERE id = p_token_id;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. admin_audit_log
--    Registra ogni azione rilevante eseguita da admin/tecnici.
--    Append-only: trigger blocca UPDATE e DELETE come su presence_logs.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL,
  user_id     uuid,                    -- auth.uid() dell'operatore
  user_role   text,                    -- owner / admin / tech / viewer
  action      text        NOT NULL,    -- es. 'worker.create', 'site.pin_set', 'session.revoke'
  target_type text,                    -- 'worker', 'site', 'session', 'asl_token'
  target_id   uuid,
  payload     jsonb,                   -- dati rilevanti (nessun segreto)
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_company_ts ON admin_audit_log(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action     ON admin_audit_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target     ON admin_audit_log(target_type, target_id);

-- RLS: solo i membri della company leggono il proprio log
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_log_company_select" ON admin_audit_log
  FOR SELECT USING (is_company_member(company_id));
-- INSERT solo via service_role (backend) — nessuna client policy

-- Trigger append-only (identico a presence_logs)
CREATE OR REPLACE FUNCTION _admin_audit_log_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only: % not allowed', TG_OP;
END;
$$;

CREATE TRIGGER tg_audit_no_update
  BEFORE UPDATE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION _admin_audit_log_append_only();

CREATE TRIGGER tg_audit_no_delete
  BEFORE DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION _admin_audit_log_append_only();
