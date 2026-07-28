-- ─── 142_value_metrics.sql ────────────────────────────────────────────────────
-- Layer "proof of value" — step 2: tabella precalcolata letta dal widget
-- dashboard impresa. Aggiornata dal cron esistente services/dailyStatsCron.js
-- (00:15 Europe/Rome), MAI ricalcolata a ogni load — vedi services/valueMetrics.js.
--
-- has_data=false → il frontend mostra lo stato vuoto onesto ("Inizia a caricare
-- documenti per vedere il tuo impatto"), mai zeri finti.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS value_metrics (
  company_id                uuid        PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  scadenze_intercettate     integer     NOT NULL DEFAULT 0,
  sanzioni_evitate_cents    bigint      NOT NULL DEFAULT 0,
  documenti_generati        integer     NOT NULL DEFAULT 0,
  ore_presenza_tracciate    numeric(10,1) NOT NULL DEFAULT 0,
  has_data                  boolean     NOT NULL DEFAULT false,
  computed_at               timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE value_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "value_metrics_select_own" ON value_metrics;
CREATE POLICY "value_metrics_select_own"
  ON value_metrics FOR SELECT
  TO authenticated
  USING (is_company_member(company_id));

-- Nessuna policy INSERT/UPDATE per authenticated: scritto solo dal cron
-- giornaliero (service_role) via services/valueMetrics.js.

-- ── Log documenti generati da Palladia (PDF/Excel) ─────────────────────────────
-- pos_documents (mig. 030) copre già i POS — questa tabella copre gli export
-- che finora non lasciavano traccia: contratto subappalto, report chat,
-- report vigilanza (quest'ultimo aggiunto in uno step successivo).
CREATE TABLE IF NOT EXISTS document_exports (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id      uuid,
  export_type  text        NOT NULL CHECK (export_type IN (
                 'contratto_subappalto', 'report_chat_pdf', 'report_chat_excel', 'report_vigilanza'
               )),
  title        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_exports_company ON document_exports(company_id, created_at DESC);

ALTER TABLE document_exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "document_exports_select_own" ON document_exports;
CREATE POLICY "document_exports_select_own"
  ON document_exports FOR SELECT
  TO authenticated
  USING (is_company_member(company_id));

-- Nessuna policy INSERT per authenticated: scritto solo dal backend (service_role)
-- al momento della generazione riuscita del PDF/Excel.
