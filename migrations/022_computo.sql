-- 022_computo.sql
-- Computo Metrico digitale con SAL per voce

-- ── Tabella computo (documento importato per cantiere) ──────────
CREATE TABLE IF NOT EXISTS site_computo (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id          UUID          NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
  nome             TEXT          NOT NULL DEFAULT 'Computo metrico',
  fonte            TEXT          CHECK (fonte IN ('pdf', 'excel', 'manuale')),
  file_path        TEXT,
  totale_contratto NUMERIC(14,2),
  created_by       UUID          REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── Tabella voci (categorie + righe lavorazione) ────────────────
CREATE TABLE IF NOT EXISTS site_computo_voci (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  computo_id      UUID          NOT NULL REFERENCES site_computo(id) ON DELETE CASCADE,
  company_id      UUID          NOT NULL REFERENCES companies(id),
  site_id         UUID          NOT NULL REFERENCES sites(id),
  parent_id       UUID          REFERENCES site_computo_voci(id) ON DELETE CASCADE,
  tipo            TEXT          NOT NULL CHECK (tipo IN ('categoria', 'voce')),
  sort_order      INTEGER       NOT NULL DEFAULT 0,
  codice          TEXT,
  descrizione     TEXT          NOT NULL,
  unita_misura    TEXT,
  quantita        NUMERIC(12,4),
  prezzo_unitario NUMERIC(12,4),
  importo         NUMERIC(14,2),
  sal_percentuale NUMERIC(5,2)  NOT NULL DEFAULT 0
    CONSTRAINT sal_voce_range CHECK (sal_percentuale >= 0 AND sal_percentuale <= 100),
  sal_note        TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Indici
CREATE INDEX IF NOT EXISTS idx_computo_site       ON site_computo(site_id);
CREATE INDEX IF NOT EXISTS idx_computo_company    ON site_computo(company_id);
CREATE INDEX IF NOT EXISTS idx_computo_voci_comp  ON site_computo_voci(computo_id);
CREATE INDEX IF NOT EXISTS idx_computo_voci_par   ON site_computo_voci(parent_id);
CREATE INDEX IF NOT EXISTS idx_computo_voci_site  ON site_computo_voci(site_id);

-- RLS
ALTER TABLE site_computo      ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_computo_voci ENABLE ROW LEVEL SECURITY;

CREATE POLICY "computo_company_member" ON site_computo
  FOR ALL USING (is_company_member(company_id))
  WITH CHECK    (is_company_member(company_id));

CREATE POLICY "computo_voci_company_member" ON site_computo_voci
  FOR ALL USING (is_company_member(company_id))
  WITH CHECK    (is_company_member(company_id));

-- Trigger updated_at
CREATE OR REPLACE FUNCTION _computo_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_computo_updated_at ON site_computo;
CREATE TRIGGER trg_computo_updated_at
  BEFORE UPDATE ON site_computo
  FOR EACH ROW EXECUTE FUNCTION _computo_updated_at();

DROP TRIGGER IF EXISTS trg_computo_voci_updated_at ON site_computo_voci;
CREATE TRIGGER trg_computo_voci_updated_at
  BEFORE UPDATE ON site_computo_voci
  FOR EACH ROW EXECUTE FUNCTION _computo_updated_at();
