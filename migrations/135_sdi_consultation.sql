-- Migration 135: consultazione fatture elettroniche via Delega Unificata (sola lettura)
--
-- Meccanismo complementare a sdi_configurations (migrazione 132), che invece sposta
-- il Codice Destinatario e diventa l'unico ricevente delle fatture passive.
-- Qui l'impresa concede a Palladia (tramite A-Cube, provider terzo) la delega di sola
-- "consultazione" sul Cassetto Fiscale dell'Agenzia delle Entrate: chi riceve oggi le
-- fatture (es. il commercialista) continua a riceverle esattamente come ora — Palladia
-- legge in parallelo la stessa copia che l'Agenzia delle Entrate conserva comunque per
-- ogni fattura transitata sul sistema, indipendentemente da chi l'ha ricevuta.
--
-- Vedi services/sdiConsultation.js per il flusso completo e le note di onestà tecnica
-- sugli endpoint A-Cube non ancora verificati con un account reale.

CREATE TABLE IF NOT EXISTS sdi_consultation_configurations (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_id                 text        NOT NULL,   -- P.IVA/CF per cui è richiesta la consultazione
  provider                  text        NOT NULL DEFAULT 'acube',
  environment               text        NOT NULL DEFAULT 'sandbox'
                             CHECK (environment IN ('sandbox', 'production')),
  status                    text        NOT NULL DEFAULT 'pending_delegation'
                             CHECK (status IN ('pending_delegation', 'active', 'error', 'disabled')),
  provider_brc_id           text,       -- id "Business Registry Configuration" lato A-Cube
  last_poll_at              timestamptz,
  last_invoice_date_covered date,       -- water-mark: fatture già importate fino a questa data
  last_invoice_received_at  timestamptz, -- allineato a sdi_configurations, aggiornato da ingestMappedExpense
  error_message             text,
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id)
);

ALTER TABLE sdi_consultation_configurations ENABLE ROW LEVEL SECURITY;

CREATE POLICY sdi_consultation_configurations_rw ON sdi_consultation_configurations FOR ALL
  USING (is_company_member(company_id));

-- Le fatture importate via consultazione condividono company_expenses con quelle via
-- webhook (colonna `source` già esistente dalla migrazione 132), serve solo ammettere
-- il nuovo valore.
ALTER TABLE company_expenses DROP CONSTRAINT IF EXISTS company_expenses_source_check;
ALTER TABLE company_expenses ADD CONSTRAINT company_expenses_source_check
  CHECK (source IN ('manual', 'ocr_scan', 'sdi_auto', 'sdi_consultation'));
