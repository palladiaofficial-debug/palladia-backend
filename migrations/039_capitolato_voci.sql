-- Migration 039: voci estratte dal capitolato speciale d'appalto
-- Il PDF viene salvato in site-documents bucket con category='capitolato'
-- Le voci strutturate vengono estratte via Claude e salvate qui

CREATE TABLE IF NOT EXISTS capitolato_voci (
  id                  uuid          NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id             uuid          NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  codice              text,                    -- es. "A.1.3", "CAT-02"
  categoria           text          NOT NULL,  -- fase/categoria es. "Impermeabilizzazioni"
  descrizione         text          NOT NULL,
  unita_misura        text,                    -- mq, mc, ml, ore, corpo, cadauno
  quantita            numeric,
  prezzo_unitario     numeric,
  importo_contratto   numeric,                 -- quantita * prezzo_unitario (valore contrattuale)
  sort_order          integer       NOT NULL DEFAULT 0,
  created_at          timestamptz   NOT NULL DEFAULT now()
);

ALTER TABLE capitolato_voci ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_members_capitolato_voci"
  ON capitolato_voci FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

CREATE INDEX IF NOT EXISTS idx_capitolato_voci_site
  ON capitolato_voci (site_id);

CREATE INDEX IF NOT EXISTS idx_capitolato_voci_site_cat
  ON capitolato_voci (site_id, categoria);
