-- Migration 063: Studio CDL Partner
-- Portale per Consulenti del Lavoro (CDL) che gestiscono N imprese clienti
-- Architettura: studio_partners → studio_users (team CDL) + studio_clients (imprese)

-- ── Tabelle ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS studio_partners (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  studio_name           TEXT        NOT NULL,
  vat_number            TEXT,
  registration_number   TEXT,                          -- numero albo CDL
  operative_regions     TEXT[]      DEFAULT '{}',
  bio                   TEXT,
  logo_url              TEXT,
  edil_connect_code     TEXT,                          -- codice ente bilaterale / Edil Connect
  onboarding_completed  BOOLEAN     DEFAULT false,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS studio_users (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   UUID        NOT NULL REFERENCES studio_partners(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL DEFAULT 'collaborator'
                          CHECK (role IN ('owner','admin','collaborator')),
  invited_at  TIMESTAMPTZ DEFAULT NOW(),
  joined_at   TIMESTAMPTZ,
  UNIQUE(studio_id, user_id)
);

CREATE TABLE IF NOT EXISTS studio_clients (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id      UUID        NOT NULL REFERENCES studio_partners(id) ON DELETE CASCADE,
  company_id     UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status         TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','active','suspended')),
  permissions    JSONB       DEFAULT '{"read_workers":true,"read_sites":true,"read_documents":true,"read_dvr":true,"generate_dvr":true}',
  invited_by     UUID        REFERENCES auth.users(id),
  invite_token   TEXT        UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  invite_sent_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(studio_id, company_id)
);

-- ── Indici ─────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_studio_clients_studio  ON studio_clients(studio_id, status);
CREATE INDEX IF NOT EXISTS idx_studio_clients_company ON studio_clients(company_id);
CREATE INDEX IF NOT EXISTS idx_studio_users_studio    ON studio_users(studio_id);
CREATE INDEX IF NOT EXISTS idx_studio_users_user      ON studio_users(user_id);

-- ── RLS helper ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION is_studio_member(p_studio_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM studio_users
    WHERE studio_id = p_studio_id AND user_id = auth.uid()
  )
$$;

-- ── RLS ────────────────────────────────────────────────────────────────────────

ALTER TABLE studio_partners ENABLE ROW LEVEL SECURITY;

CREATE POLICY studio_partners_select ON studio_partners FOR SELECT
  USING (is_studio_member(id) OR user_id = auth.uid());
CREATE POLICY studio_partners_insert ON studio_partners FOR INSERT
  WITH CHECK (user_id = auth.uid());
CREATE POLICY studio_partners_update ON studio_partners FOR UPDATE
  USING (is_studio_member(id));

ALTER TABLE studio_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY studio_users_select ON studio_users FOR SELECT
  USING (is_studio_member(studio_id) OR user_id = auth.uid());
CREATE POLICY studio_users_insert ON studio_users FOR INSERT
  WITH CHECK (is_studio_member(studio_id) OR user_id = auth.uid());

ALTER TABLE studio_clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY studio_clients_select ON studio_clients FOR SELECT
  USING (is_studio_member(studio_id));
CREATE POLICY studio_clients_insert ON studio_clients FOR INSERT
  WITH CHECK (is_studio_member(studio_id));
CREATE POLICY studio_clients_update ON studio_clients FOR UPDATE
  USING (is_studio_member(studio_id));
CREATE POLICY studio_clients_delete ON studio_clients FOR DELETE
  USING (is_studio_member(studio_id));

-- ── Trigger updated_at ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _studio_partners_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER studio_partners_updated_at
  BEFORE UPDATE ON studio_partners
  FOR EACH ROW EXECUTE FUNCTION _studio_partners_updated_at();
