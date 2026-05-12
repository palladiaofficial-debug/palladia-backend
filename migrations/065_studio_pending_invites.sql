-- Migration 065: Inviti CDL per P.IVA/email (imprese non ancora su Palladia)
-- Permette al CDL di invitare imprese clienti inserendo P.IVA + email,
-- anche se l'impresa non ha ancora un account Palladia.

CREATE TABLE IF NOT EXISTS studio_pending_invites (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id       UUID        NOT NULL REFERENCES studio_partners(id) ON DELETE CASCADE,
  contact_email   TEXT        NOT NULL,
  contact_name    TEXT,
  company_name    TEXT,
  vat_number      TEXT,
  invite_token    TEXT        UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','accepted','expired')),
  invited_by      UUID        REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  accepted_at     TIMESTAMPTZ,
  UNIQUE(studio_id, contact_email)
);

CREATE INDEX IF NOT EXISTS idx_pending_invites_studio ON studio_pending_invites(studio_id);
CREATE INDEX IF NOT EXISTS idx_pending_invites_email  ON studio_pending_invites(contact_email);
CREATE INDEX IF NOT EXISTS idx_pending_invites_vat    ON studio_pending_invites(vat_number) WHERE vat_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_piva         ON companies(piva) WHERE piva IS NOT NULL;

ALTER TABLE studio_pending_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY pending_invites_select ON studio_pending_invites FOR SELECT
  USING (is_studio_member(studio_id));
CREATE POLICY pending_invites_insert ON studio_pending_invites FOR INSERT
  WITH CHECK (is_studio_member(studio_id));
CREATE POLICY pending_invites_update ON studio_pending_invites FOR UPDATE
  USING (is_studio_member(studio_id));
CREATE POLICY pending_invites_delete ON studio_pending_invites FOR DELETE
  USING (is_studio_member(studio_id));
