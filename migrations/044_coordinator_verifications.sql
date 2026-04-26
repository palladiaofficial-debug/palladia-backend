-- Migration 044: Verifiche Coordinatore
-- Registro immutabile delle verifiche formali di sicurezza effettuate dai coordinatori.
-- Ogni record è append-only (trigger blocca UPDATE/DELETE) — costituisce evidenza digitale.

CREATE TABLE IF NOT EXISTS coordinator_verifications (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id        UUID        NOT NULL REFERENCES site_coordinator_invites(id) ON DELETE CASCADE,
  company_id       UUID        NOT NULL REFERENCES companies(id)             ON DELETE CASCADE,
  site_id          UUID        NOT NULL REFERENCES sites(id)                 ON DELETE CASCADE,
  coordinator_name TEXT        NOT NULL,
  coordinator_email TEXT,
  accessed_via     TEXT        NOT NULL DEFAULT 'cse'
                               CHECK (accessed_via IN ('cse', 'pro')),

  -- Stato sicurezza al momento della verifica
  safety_status    TEXT        NOT NULL DEFAULT 'dati_insufficienti'
                               CHECK (safety_status IN ('conforme', 'attenzione', 'critico', 'dati_insufficienti')),

  -- Metriche snapshot (non modificabili dopo inserimento)
  open_nc_count         INTEGER NOT NULL DEFAULT 0,
  critical_nc_count     INTEGER NOT NULL DEFAULT 0,
  non_compliant_workers INTEGER NOT NULL DEFAULT 0,
  expiring_workers      INTEGER NOT NULL DEFAULT 0,
  workers_present_today INTEGER NOT NULL DEFAULT 0,

  -- Snapshot JSON degli elementi attivi al momento della verifica
  active_issues_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  document_snapshot      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Nota opzionale del coordinatore
  note TEXT CHECK (note IS NULL OR char_length(trim(note)) <= 2000),

  -- Metadati accesso
  ip_address TEXT,
  user_agent TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coord_verif_site    ON coordinator_verifications(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coord_verif_invite  ON coordinator_verifications(invite_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coord_verif_company ON coordinator_verifications(company_id);

-- Trigger append-only: stesso pattern di presence_logs e admin_audit_log.
-- Funziona anche con service_role perché è DB-level, non RLS.
CREATE OR REPLACE FUNCTION _coord_verif_append_only()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RAISE EXCEPTION 'coordinator_verifications è append-only — UPDATE/DELETE vietati';
END;
$$;

DROP TRIGGER IF EXISTS trg_coord_verif_no_update ON coordinator_verifications;
CREATE TRIGGER trg_coord_verif_no_update
  BEFORE UPDATE ON coordinator_verifications
  FOR EACH ROW EXECUTE FUNCTION _coord_verif_append_only();

DROP TRIGGER IF EXISTS trg_coord_verif_no_delete ON coordinator_verifications;
CREATE TRIGGER trg_coord_verif_no_delete
  BEFORE DELETE ON coordinator_verifications
  FOR EACH ROW EXECUTE FUNCTION _coord_verif_append_only();
