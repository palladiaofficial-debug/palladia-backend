-- 100_payslips_v2.sql
-- Buste paga: estende la tabella payslips (096) con tutti i campi necessari.
-- Sicuro da applicare sia se 096 è già stato eseguito che se non lo è.

-- ── Crea la tabella completa se non esiste già ────────────────────────────────
CREATE TABLE IF NOT EXISTS payslips (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id       UUID        REFERENCES studio_partners(id) ON DELETE SET NULL,
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_id       UUID        REFERENCES workers(id) ON DELETE SET NULL,
  uploaded_by     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  period_year     SMALLINT    NOT NULL,
  period_month    SMALLINT    NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  filename        TEXT        NOT NULL,
  file_path       TEXT        NOT NULL,
  file_size       INTEGER,
  status          TEXT        NOT NULL DEFAULT 'draft',
  note            TEXT,
  shared_at       TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_ip TEXT,
  acknowledged_ua TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Se la tabella esisteva già (096), porta studio_id a nullable e aggiungi colonne ─
DO $$
BEGIN
  -- studio_id nullable (in 096 era NOT NULL)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payslips' AND column_name = 'studio_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE payslips ALTER COLUMN studio_id DROP NOT NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payslips' AND column_name='uploaded_by') THEN
    ALTER TABLE payslips ADD COLUMN uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payslips' AND column_name='status') THEN
    ALTER TABLE payslips ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payslips' AND column_name='note') THEN
    ALTER TABLE payslips ADD COLUMN note TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payslips' AND column_name='shared_at') THEN
    ALTER TABLE payslips ADD COLUMN shared_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payslips' AND column_name='acknowledged_at') THEN
    ALTER TABLE payslips ADD COLUMN acknowledged_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payslips' AND column_name='acknowledged_ip') THEN
    ALTER TABLE payslips ADD COLUMN acknowledged_ip TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payslips' AND column_name='acknowledged_ua') THEN
    ALTER TABLE payslips ADD COLUMN acknowledged_ua TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='payslips' AND column_name='updated_at') THEN
    ALTER TABLE payslips ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;
END $$;

-- ── CHECK constraint su status ────────────────────────────────────────────────
ALTER TABLE payslips DROP CONSTRAINT IF EXISTS payslips_status_check;
ALTER TABLE payslips ADD CONSTRAINT payslips_status_check
  CHECK (status IN ('draft', 'shared', 'acknowledged'));

-- ── Indici ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_payslips_company_worker
  ON payslips(company_id, worker_id, period_year DESC, period_month DESC);

CREATE INDEX IF NOT EXISTS idx_payslips_studio
  ON payslips(studio_id, company_id) WHERE studio_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payslips_shared
  ON payslips(company_id, status) WHERE status IN ('shared', 'acknowledged');

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE payslips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company members manage payslips" ON payslips;
CREATE POLICY "company members manage payslips"
  ON payslips FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

-- ── Bucket storage: crea se non esiste (Supabase Dashboard > Storage) ─────────
-- NOTA MANUALE: creare il bucket 'payslips' su Supabase con accesso privato.
-- I signed URL durano 1 ora (generati dal backend on-demand).
