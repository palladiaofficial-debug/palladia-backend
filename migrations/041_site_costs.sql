-- Migration 041: costi reali del cantiere (fatture, DDT, acconti)
-- Confrontati con importo_contratto del capitolato per rilevare sforamenti

CREATE TABLE IF NOT EXISTS site_costs (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id            uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id               uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  phase_id              uuid        REFERENCES site_phases(id) ON DELETE SET NULL,
  capitolato_voce_id    uuid        REFERENCES capitolato_voci(id) ON DELETE SET NULL,
  descrizione           text        NOT NULL,
  fornitore             text,
  quantita              numeric,
  unita_misura          text,
  prezzo_unitario       numeric,
  importo               numeric     NOT NULL,
  data_documento        date,
  tipo                  text        NOT NULL DEFAULT 'fattura'
    CHECK (tipo IN ('fattura', 'ddt', 'acconto', 'ritenuta', 'altro')),
  numero_documento      text,
  file_url              text,       -- foto/scan fattura in bucket site-media
  note                  text,
  created_by            text,       -- 'web:{user_id}' | 'telegram:{chat_id}'
  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE site_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_members_site_costs"
  ON site_costs FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

CREATE INDEX IF NOT EXISTS idx_site_costs_site_date
  ON site_costs (site_id, data_documento DESC);

CREATE INDEX IF NOT EXISTS idx_site_costs_site_phase
  ON site_costs (site_id, phase_id);

CREATE INDEX IF NOT EXISTS idx_site_costs_company
  ON site_costs (company_id);
