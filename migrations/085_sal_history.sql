-- Migration 085: Storico SAL per cantiere
-- Ogni emissione di SAL salva uno snapshot economico + PDF in storage.

CREATE TABLE IF NOT EXISTS site_sal_history (
  id                  uuid          DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          uuid          NOT NULL REFERENCES companies(id),
  site_id             uuid          NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  sal_number          integer       NOT NULL,                          -- progressivo per cantiere
  sal_percentuale     numeric(5,2)  NOT NULL DEFAULT 0,
  data_emissione      date          NOT NULL DEFAULT CURRENT_DATE,
  totale_contratto    numeric(12,2),
  importo_maturato    numeric(12,2),
  costo_mo            numeric(12,2) NOT NULL DEFAULT 0,
  costi_diretti       numeric(12,2) NOT NULL DEFAULT 0,
  totale_costi        numeric(12,2) NOT NULL DEFAULT 0,
  margine             numeric(12,2),
  margine_percentuale numeric(6,2),
  note                text,
  pdf_url             text,                                           -- percorso in Supabase Storage
  created_by          text,
  created_at          timestamptz   DEFAULT now(),
  UNIQUE(site_id, sal_number)
);

ALTER TABLE site_sal_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "site_sal_history_company_member"
  ON site_sal_history FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

CREATE INDEX IF NOT EXISTS site_sal_history_site_idx ON site_sal_history(site_id);
CREATE INDEX IF NOT EXISTS site_sal_history_company_idx ON site_sal_history(company_id);
