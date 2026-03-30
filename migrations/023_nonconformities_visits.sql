-- ── Migration 023: Non Conformità + Registro Visite Coordinatori ───────────────
-- Tabella non_conformities: rilievi formali aperti dal coordinatore
-- Tabella coordinator_visits: log accessi coordinatori per ogni cantiere

-- ── Non Conformità ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_nonconformities (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id                   UUID        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  invite_id                 UUID        NOT NULL REFERENCES site_coordinator_invites(id) ON DELETE CASCADE,
  coordinator_name          TEXT        NOT NULL,

  -- Contenuto
  title                     TEXT        NOT NULL CHECK (char_length(trim(title)) >= 3),
  description               TEXT        NOT NULL CHECK (char_length(trim(description)) >= 3),
  category                  TEXT        NOT NULL DEFAULT 'sicurezza'
                            CHECK (category IN ('sicurezza', 'documentale', 'operativa', 'igiene')),
  severity                  TEXT        NOT NULL DEFAULT 'media'
                            CHECK (severity IN ('bassa', 'media', 'alta', 'critica')),

  -- Ciclo di vita
  status                    TEXT        NOT NULL DEFAULT 'aperta'
                            CHECK (status IN ('aperta', 'in_lavorazione', 'risolta', 'chiusa')),
  due_date                  DATE,

  -- Risposta impresa
  resolution_notes          TEXT,
  resolved_at               TIMESTAMPTZ,

  -- Validazione coordinatore
  closed_by_coordinator_at  TIMESTAMPTZ,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nc_site    ON site_nonconformities(site_id);
CREATE INDEX IF NOT EXISTS idx_nc_company ON site_nonconformities(company_id);
CREATE INDEX IF NOT EXISTS idx_nc_invite  ON site_nonconformities(invite_id);
-- Indice parziale per query "NC aperte" — il caso più frequente
CREATE INDEX IF NOT EXISTS idx_nc_open    ON site_nonconformities(site_id, created_at DESC)
  WHERE status NOT IN ('chiusa');

-- ── Registro Visite ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coordinator_visits (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id         UUID        NOT NULL REFERENCES site_coordinator_invites(id) ON DELETE CASCADE,
  company_id        UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id           UUID        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  coordinator_name  TEXT        NOT NULL,
  coordinator_email TEXT,
  accessed_via      TEXT        NOT NULL DEFAULT 'cse'
                    CHECK (accessed_via IN ('cse', 'pro')),
  visited_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visits_site    ON coordinator_visits(site_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_invite  ON coordinator_visits(invite_id, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_company ON coordinator_visits(company_id);
