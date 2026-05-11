-- Migration 062: Subappaltatori Enterprise
-- 1. Collega ogni lavoratore al proprio subappaltatore (opzionale)
-- 2. Crea tabella documenti per ogni subappaltatore (DURC, polizza, SOA, visura, ecc.)

-- ── 1. Link workers → subcontractors ─────────────────────────────────────────
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS subcontractor_id UUID REFERENCES subcontractors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workers_subcontractor
  ON workers(subcontractor_id)
  WHERE subcontractor_id IS NOT NULL;

-- ── 2. Documenti ufficiali per ogni subappaltatore ────────────────────────────
CREATE TABLE IF NOT EXISTS subcontractor_documents (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subcontractor_id UUID        NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  category         TEXT        NOT NULL DEFAULT 'altro',
    -- durc | insurance | soa | visura | iso | f24 | altro
  file_path        TEXT        NOT NULL,
  file_size        INTEGER,
  mime_type        TEXT,
  valid_until      DATE,
  ai_summary       TEXT,
  ai_expiry_date   DATE,
  ai_issues        JSONB       DEFAULT '[]',
  ai_validity_ok   BOOLEAN,
  ai_analyzed_at   TIMESTAMPTZ,
  uploaded_by      UUID,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subdocs_company
  ON subcontractor_documents(company_id);

CREATE INDEX IF NOT EXISTS idx_subdocs_sub
  ON subcontractor_documents(subcontractor_id);

-- RLS: solo i membri della company accedono ai propri documenti sub
ALTER TABLE subcontractor_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY subdocs_select ON subcontractor_documents FOR SELECT
  USING (is_company_member(company_id));

CREATE POLICY subdocs_insert ON subcontractor_documents FOR INSERT
  WITH CHECK (is_company_member(company_id));

CREATE POLICY subdocs_delete ON subcontractor_documents FOR DELETE
  USING (is_company_member(company_id));

-- ── 3. Vista workforce per cantiere ──────────────────────────────────────────
-- Mostra tutti i lavoratori attivi su un cantiere con info subappaltatore.
-- Usata dall'endpoint GET /api/v1/sites/:siteId/workforce.
CREATE OR REPLACE VIEW site_workforce AS
SELECT
  ww.site_id,
  ww.company_id,
  w.id             AS worker_id,
  w.full_name,
  w.fiscal_code,
  w.is_active,
  w.subcontractor_id,
  s.company_name   AS subcontractor_name,
  s.durc_expiry,
  s.insurance_expiry,
  s.soa_expiry,
  s.is_active      AS subcontractor_active,
  ww.status        AS assignment_status
FROM worksite_workers ww
JOIN workers w
  ON w.id = ww.worker_id
LEFT JOIN subcontractors s
  ON s.id = w.subcontractor_id
WHERE ww.status = 'active'
  AND w.is_active = true;
