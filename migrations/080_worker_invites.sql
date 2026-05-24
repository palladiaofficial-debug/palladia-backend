-- Migration 080: Onboarding self-service lavoratori
-- Tabella token invito + colonna pending_approval su workers

-- ── Token invito lavoratore ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker_invite_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id         uuid REFERENCES sites(id) ON DELETE SET NULL,    -- cantiere di destinazione (opzionale)
  token           text NOT NULL UNIQUE,                            -- 32 byte hex URL-safe
  created_by      uuid,                                            -- user_id Supabase dell'invitante
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  worker_id       uuid REFERENCES workers(id) ON DELETE SET NULL,  -- compilato dopo approvazione
  max_uses        int NOT NULL DEFAULT 1,                          -- quanti lavoratori possono usarlo
  uses_count      int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wit_company ON worker_invite_tokens(company_id);
CREATE INDEX IF NOT EXISTS idx_wit_token   ON worker_invite_tokens(token);

-- ── Lavoratori in attesa di approvazione ────────────────────────────────────
ALTER TABLE workers ADD COLUMN IF NOT EXISTS pending_approval boolean NOT NULL DEFAULT false;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS invite_token_id  uuid REFERENCES worker_invite_tokens(id) ON DELETE SET NULL;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS self_submitted_at timestamptz;

-- ── RLS: solo la company può leggere i propri token ─────────────────────────
ALTER TABLE worker_invite_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_members_read_invite_tokens"
  ON worker_invite_tokens FOR SELECT
  USING (is_company_member(company_id));

CREATE POLICY "company_members_insert_invite_tokens"
  ON worker_invite_tokens FOR INSERT
  WITH CHECK (is_company_member(company_id));

CREATE POLICY "company_members_update_invite_tokens"
  ON worker_invite_tokens FOR UPDATE
  USING (is_company_member(company_id));

CREATE POLICY "company_members_delete_invite_tokens"
  ON worker_invite_tokens FOR DELETE
  USING (is_company_member(company_id));
