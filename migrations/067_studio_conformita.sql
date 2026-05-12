-- Migration 067: Studio CDL — conformità estesa
-- DURC, riunione periodica, figure sicurezza (RSPP, MC, RLS, ecc.)
-- La sorveglianza sanitaria usa già il campo health_fitness_expiry su workers (migration 013)

-- ── DURC e riunione periodica su companies ────────────────────────────────────
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS durc_expiry_date DATE,
  ADD COLUMN IF NOT EXISTS last_safety_meeting_at DATE,
  ADD COLUMN IF NOT EXISTS safety_meeting_threshold INT NOT NULL DEFAULT 15;

-- ── Figure sicurezza ──────────────────────────────────────────────────────────
-- Una sola riga attiva per tipo per azienda (UNIQUE company_id + role_type).
CREATE TABLE IF NOT EXISTS company_safety_roles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_type        TEXT NOT NULL CHECK (role_type IN (
                     'rspp', 'mc', 'rls', 'preposto', 'aspp',
                     'addetto_ps', 'addetto_antincendio'
                   )),
  full_name        TEXT NOT NULL,
  appointment_date DATE,
  expiry_date      DATE,
  qualification    TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un solo nominato per tipo per azienda
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_safety_roles_uniq
  ON company_safety_roles(company_id, role_type);

CREATE INDEX IF NOT EXISTS idx_company_safety_roles_company
  ON company_safety_roles(company_id);

CREATE INDEX IF NOT EXISTS idx_company_safety_roles_expiry
  ON company_safety_roles(expiry_date)
  WHERE expiry_date IS NOT NULL;

ALTER TABLE company_safety_roles ENABLE ROW LEVEL SECURITY;

-- Studio legge e scrive per tutti i propri clienti attivi
CREATE POLICY "safety_roles_studio" ON company_safety_roles
  FOR ALL USING (
    company_id IN (
      SELECT sc.company_id
      FROM   studio_clients sc
      JOIN   studio_partners sp ON sp.id = sc.studio_id
      WHERE  sp.user_id = auth.uid() AND sc.status = 'active'
    )
  );

-- L'impresa vede i propri dati
CREATE POLICY "safety_roles_company" ON company_safety_roles
  FOR SELECT USING (
    company_id IN (
      SELECT company_id FROM company_users WHERE user_id = auth.uid()
    )
  );
