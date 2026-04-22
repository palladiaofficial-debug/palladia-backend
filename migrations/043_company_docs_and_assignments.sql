-- Migration 043 — Libreria documenti aziendali + assegnazione mezzi/subappalti ai cantieri

-- ── Documenti aziendali ────────────────────────────────────────────────────────
-- Caricati una sola volta in Risorse → Documenti, appaiono in tutti i cantieri.
CREATE TABLE IF NOT EXISTS company_documents (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  category    TEXT        NOT NULL DEFAULT 'altro',
  file_path   TEXT        NOT NULL,
  file_size   BIGINT,
  mime_type   TEXT,
  uploaded_by UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT company_docs_category_check CHECK (
    category IN ('durc','visura','dvr','iso','soa','assicurazione','f24','altro')
  )
);

CREATE INDEX IF NOT EXISTS idx_company_docs_company
  ON company_documents (company_id, created_at DESC);

-- ── Mezzi assegnati a cantiere ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_equipment (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id       UUID        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  equipment_id  UUID        NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, equipment_id)
);

CREATE INDEX IF NOT EXISTS idx_site_equipment_site ON site_equipment (site_id);

-- ── Subappalti assegnati a cantiere ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_subcontractors (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id           UUID        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  subcontractor_id  UUID        NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  role              TEXT,
  assigned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, subcontractor_id)
);

CREATE INDEX IF NOT EXISTS idx_site_subcontractors_site ON site_subcontractors (site_id);
