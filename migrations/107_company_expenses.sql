-- ═══════════════════════════════════════════════════════════════════════════════
-- 107: Gestione Spese Aziendali
-- Traccia TUTTE le uscite dell'impresa — materiali, carburante, utenze, assegni, cash
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS company_expenses (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  amount            numeric(12,2) NOT NULL CHECK (amount > 0),
  description       text        NOT NULL,
  category          text        NOT NULL DEFAULT 'altro',
  payment_method    text        NOT NULL DEFAULT 'contanti',
  payment_reference text,         -- numero assegno, CRO bonifico, ecc.
  paid_by           text,         -- nome libero: "Mario", "Maria", "Ufficio"
  supplier          text,         -- fornitore: "Leroy Merlin", "Q8", ecc.
  expense_date      date        NOT NULL DEFAULT CURRENT_DATE,
  site_id           uuid        REFERENCES sites(id) ON DELETE SET NULL,  -- nullable: spesa generale o legata a cantiere
  receipt_url       text,         -- path in Supabase Storage
  invoice_number    text,         -- numero fattura/ricevuta
  is_deductible     boolean     NOT NULL DEFAULT true,
  notes             text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_expenses_company    ON company_expenses(company_id, expense_date DESC);
CREATE INDEX idx_expenses_category   ON company_expenses(company_id, category);
CREATE INDEX idx_expenses_site       ON company_expenses(site_id) WHERE site_id IS NOT NULL;
CREATE INDEX idx_expenses_paid_by    ON company_expenses(company_id, paid_by);

ALTER TABLE company_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_expenses_rw ON company_expenses FOR ALL
  USING (is_company_member(company_id));

-- Categorie suggerite (non vincolanti — il campo è text libero):
-- materiali, carburante, utenze, assicurazioni, tasse_contributi,
-- stipendi, affitto, attrezzature, subappalto, consulenze,
-- manutenzione, trasporti, cancelleria, vitto_alloggio, altro

-- Metodi di pagamento:
-- contanti, assegno, bonifico, carta, pos, altro

-- ── Spese ricorrenti ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_recurring_expenses (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  description     text        NOT NULL,
  category        text        NOT NULL DEFAULT 'altro',
  payment_method  text        NOT NULL DEFAULT 'bonifico',
  paid_by         text,
  supplier        text,
  day_of_month    integer     NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 28),
  is_active       boolean     NOT NULL DEFAULT true,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recurring_company ON company_recurring_expenses(company_id) WHERE is_active = true;

ALTER TABLE company_recurring_expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_recurring_expenses_rw ON company_recurring_expenses FOR ALL
  USING (is_company_member(company_id));
