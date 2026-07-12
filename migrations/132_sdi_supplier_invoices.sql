-- Migration 132: ricezione automatica fatture fornitore via SdI (Sistema di Interscambio)
-- Ogni impresa può collegare la propria fatturazione elettronica passiva a Palladia
-- (via provider accreditato SdI) — le fatture fornitore arrivano già strutturate e
-- diventano spese cantiere senza inserimento manuale né OCR.

-- ── Estende company_expenses per tracciare l'origine e collegare la fattura reale ──
ALTER TABLE company_expenses
  ADD COLUMN IF NOT EXISTS source            text NOT NULL DEFAULT 'manual'
                            CHECK (source IN ('manual', 'ocr_scan', 'sdi_auto')),
  ADD COLUMN IF NOT EXISTS sdi_invoice_id     text,      -- id fattura lato provider SdI (idempotenza)
  ADD COLUMN IF NOT EXISTS supplier_vat       text,      -- P.IVA del fornitore, dalla fattura elettronica
  ADD COLUMN IF NOT EXISTS sdi_raw_invoice    jsonb;     -- fattura strutturata completa (righe, pagamento) per dettaglio/audit

-- Un'unica fattura SdI non deve mai creare due spese (retry webhook, doppie notifiche)
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_sdi_invoice_id
  ON company_expenses(company_id, sdi_invoice_id) WHERE sdi_invoice_id IS NOT NULL;

-- ── Configurazione per company: stato del collegamento al provider SdI ──────────
CREATE TABLE IF NOT EXISTS sdi_configurations (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_id                 text        NOT NULL,   -- P.IVA registrata presso il provider SdI
  provider                  text        NOT NULL DEFAULT 'openapi',
  environment               text        NOT NULL DEFAULT 'sandbox'
                             CHECK (environment IN ('sandbox', 'production')),
  status                    text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'active', 'error', 'disabled')),
  webhook_secret            text        NOT NULL,   -- verifica autenticità chiamate in ingresso dal provider
  provider_configuration_id text,                   -- id configurazione lato provider, per aggiornamenti/disattivazione
  last_invoice_received_at  timestamptz,
  error_message             text,
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id)
);

ALTER TABLE sdi_configurations ENABLE ROW LEVEL SECURITY;

CREATE POLICY sdi_configurations_rw ON sdi_configurations FOR ALL
  USING (is_company_member(company_id));
