-- 021_economia.sql
-- SAL (Stato Avanzamento Lavori): budget, costi, ricavi per cantiere

-- ── Estendi sites ──────────────────────────────────────────────
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS budget_totale   NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS sal_percentuale NUMERIC(5,2) DEFAULT 0
    CONSTRAINT sal_range CHECK (sal_percentuale >= 0 AND sal_percentuale <= 100);

-- ── Tabella voci economiche ────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_economia_voci (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id          UUID          NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
  tipo             TEXT          NOT NULL CHECK (tipo IN ('costo', 'ricavo')),
  categoria        TEXT          NOT NULL,
  voce             TEXT          NOT NULL,
  importo          NUMERIC(12,2) NOT NULL CHECK (importo > 0),
  data_competenza  DATE          NOT NULL DEFAULT CURRENT_DATE,
  note             TEXT,
  created_by       UUID          REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Indici
CREATE INDEX IF NOT EXISTS idx_economia_voci_site    ON site_economia_voci(site_id);
CREATE INDEX IF NOT EXISTS idx_economia_voci_company ON site_economia_voci(company_id);

-- RLS
ALTER TABLE site_economia_voci ENABLE ROW LEVEL SECURITY;

CREATE POLICY "economia_company_member" ON site_economia_voci
  FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

-- Trigger updated_at
CREATE OR REPLACE FUNCTION _economia_voci_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_economia_voci_updated_at ON site_economia_voci;
CREATE TRIGGER trg_economia_voci_updated_at
  BEFORE UPDATE ON site_economia_voci
  FOR EACH ROW EXECUTE FUNCTION _economia_voci_updated_at();
