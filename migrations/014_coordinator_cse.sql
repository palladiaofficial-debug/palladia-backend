-- Migration 014: Coordinatore della Sicurezza (CSE)
-- Accesso read-only per coordinatori tramite link firmato + sistema note

-- ── Inviti coordinatori ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_coordinator_invites (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
  site_id             uuid        NOT NULL REFERENCES sites(id)      ON DELETE CASCADE,
  token_hash          text        UNIQUE NOT NULL,
  coordinator_name    text        NOT NULL CHECK (length(trim(coordinator_name)) > 0),
  coordinator_email   text,
  coordinator_company text,
  created_by          uuid,
  expires_at          timestamptz NOT NULL,
  last_accessed_at    timestamptz,
  access_count        int         NOT NULL DEFAULT 0,
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coord_invites_token   ON site_coordinator_invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_coord_invites_site    ON site_coordinator_invites(site_id);
CREATE INDEX IF NOT EXISTS idx_coord_invites_company ON site_coordinator_invites(company_id);

-- ── Note del coordinatore ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_coordinator_notes (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES companies(id)             ON DELETE CASCADE,
  site_id          uuid        NOT NULL REFERENCES sites(id)                 ON DELETE CASCADE,
  invite_id        uuid        NOT NULL REFERENCES site_coordinator_invites(id) ON DELETE CASCADE,
  note_type        text        NOT NULL DEFAULT 'observation'
                               CHECK (note_type IN ('observation','request','approval','warning')),
  content          text        NOT NULL CHECK (length(trim(content)) >= 3),
  coordinator_name text        NOT NULL,
  is_read          boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coord_notes_site   ON site_coordinator_notes(site_id);
CREATE INDEX IF NOT EXISTS idx_coord_notes_invite ON site_coordinator_notes(invite_id);
CREATE INDEX IF NOT EXISTS idx_coord_notes_unread ON site_coordinator_notes(site_id, is_read) WHERE NOT is_read;
