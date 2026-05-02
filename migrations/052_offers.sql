-- 052_offers.sql
-- Offerte economiche: preventivi e gare d'appalto (senza cantiere)

-- ── Tabella offerta ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS offers (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  nome           TEXT          NOT NULL DEFAULT 'Nuova offerta',
  cliente        TEXT,
  oggetto        TEXT,
  stato          TEXT          NOT NULL DEFAULT 'bozza'
                               CHECK (stato IN ('bozza','inviata','vinta','persa')),
  totale_offerta NUMERIC(14,2),
  note           TEXT,
  fonte          TEXT          CHECK (fonte IN ('pdf','excel','manuale')),
  created_by     UUID          REFERENCES auth.users(id),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── Righe dell'offerta (categorie + voci lavorazione) ────────────────────────
CREATE TABLE IF NOT EXISTS offer_items (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id        UUID          NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  company_id      UUID          NOT NULL REFERENCES companies(id),
  parent_id       UUID          REFERENCES offer_items(id) ON DELETE CASCADE,
  tipo            TEXT          NOT NULL CHECK (tipo IN ('categoria','voce')),
  sort_order      INTEGER       NOT NULL DEFAULT 0,
  codice          TEXT,
  descrizione     TEXT          NOT NULL,
  unita_misura    TEXT,
  quantita        NUMERIC(12,4),
  prezzo_ref      NUMERIC(12,4),    -- prezzo dal capitolato (sola lettura)
  prezzo_offerta  NUMERIC(12,4),    -- prezzo impresa (editabile)
  importo_offerta NUMERIC(14,2),    -- quantita × prezzo_offerta
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Indici
CREATE INDEX IF NOT EXISTS idx_offers_company      ON offers(company_id);
CREATE INDEX IF NOT EXISTS idx_offers_stato        ON offers(stato);
CREATE INDEX IF NOT EXISTS idx_offer_items_offer   ON offer_items(offer_id);
CREATE INDEX IF NOT EXISTS idx_offer_items_parent  ON offer_items(parent_id);
CREATE INDEX IF NOT EXISTS idx_offer_items_comp    ON offer_items(company_id);

-- RLS
ALTER TABLE offers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "offers_company_member" ON offers
  FOR ALL USING (is_company_member(company_id))
  WITH CHECK    (is_company_member(company_id));

CREATE POLICY "offer_items_company_member" ON offer_items
  FOR ALL USING (is_company_member(company_id))
  WITH CHECK    (is_company_member(company_id));

-- Trigger updated_at
CREATE OR REPLACE FUNCTION _offers_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_offers_updated_at ON offers;
CREATE TRIGGER trg_offers_updated_at
  BEFORE UPDATE ON offers FOR EACH ROW EXECUTE FUNCTION _offers_updated_at();

DROP TRIGGER IF EXISTS trg_offer_items_updated_at ON offer_items;
CREATE TRIGGER trg_offer_items_updated_at
  BEFORE UPDATE ON offer_items FOR EACH ROW EXECUTE FUNCTION _offers_updated_at();
