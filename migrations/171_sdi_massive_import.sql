-- Migration 171: importazione massiva dello storico fatture (download massivo
-- Agenzia delle Entrate, portale Fatture e Corrispettivi).
--
-- Il canale email (F-060/F-061) e la delega Cassetto Fiscale (A-Cube) coprono solo
-- le fatture da oggi in poi. Per lo storico — cantieri aperti da mesi o anni — il
-- titolare scarica dal portale AdE uno ZIP con tutte le fatture ricevute nel
-- periodo scelto e lo carica qui. Stesso motore di estrazione/ingest già
-- verificato per email e consultazione (lib/fatturaPaEnvelopeParser.js,
-- services/sdiInvoices.js::ingestMappedExpense) — solo l'origine del file cambia.
--
-- Elaborazione in background (centinaia di fatture, possibili chiamate AI per
-- categoria/cantiere ambiguo): questa tabella traccia l'avanzamento per il
-- polling della procedura guidata, sullo stesso modello di import_batches.

CREATE TABLE IF NOT EXISTS sdi_massive_import_batches (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by                  uuid,
  status                      text        NOT NULL DEFAULT 'processing'
                               CHECK (status IN ('processing', 'done', 'error')),
  total_candidates            integer     NOT NULL DEFAULT 0, -- fatture XML/p7m trovate nello zip
  processed_count             integer     NOT NULL DEFAULT 0,
  imported_count               integer     NOT NULL DEFAULT 0,
  duplicate_count              integer     NOT NULL DEFAULT 0,
  pending_review_count         integer     NOT NULL DEFAULT 0,
  error_count                  integer     NOT NULL DEFAULT 0,
  skipped_not_invoice_count    integer     NOT NULL DEFAULT 0, -- notifiche/ricevute SdI, xml non riconosciuti
  overflow_count                integer     NOT NULL DEFAULT 0, -- oltre il tetto per richiesta, da dividere in più caricamenti
  error_message                text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  finished_at                  timestamptz
);

ALTER TABLE sdi_massive_import_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY sdi_massive_import_batches_r ON sdi_massive_import_batches FOR SELECT
  USING (is_company_member(company_id));

CREATE INDEX IF NOT EXISTS idx_sdi_massive_import_batches_company ON sdi_massive_import_batches(company_id, created_at DESC);

-- Nuova origine spesa: fattura importata da un caricamento massivo dello storico,
-- distinta da 'email' (arrivata via inoltro) e 'acube' (consultazione periodica).
ALTER TABLE company_expenses DROP CONSTRAINT IF EXISTS company_expenses_source_check;
ALTER TABLE company_expenses ADD CONSTRAINT company_expenses_source_check
  CHECK (source IN ('manual', 'acube', 'email', 'sdi_massive'));
