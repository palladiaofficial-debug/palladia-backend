-- Migration 165: canale fatture fornitore via inoltro email
--
-- Terzo canale di ingresso fatture, sullo stesso impianto di sdi_configurations
-- (migrazione 132, provider Openapi — mai attivato) e sdi_consultation_configurations
-- (migrazione 135, provider A-Cube). Le fatture arrivano come allegato di un'email
-- inoltrata a un indirizzo dedicato per company, invece che via webhook o
-- consultazione del Cassetto Fiscale — ma diventano righe company_expenses con lo
-- stesso ingest condiviso (services/sdiInvoices.js::ingestMappedExpense).
--
-- Approfittiamo di questa migrazione per ripulire la tassonomia `source`: 'ocr_scan'
-- non è mai stato scritto da nessun codice (verificato per grep in tutto il repo),
-- e 'sdi_auto' (integrazione Openapi) è oggi irraggiungibile — richiede
-- OPENAPI_API_KEY mai configurata, sdiRequest() fallisce prima di qualunque insert.
-- Il letterale 'sdi_auto' resta scritto in services/sdiInvoices.js:246 come codice
-- morto: se quell'integrazione venisse mai riattivata senza prima essere rivista,
-- l'insert fallirebbe sul CHECK — segnalato qui per trasparenza, non in scope ora.

-- ── Pulizia tassonomia source ────────────────────────────────────────────────────
-- Prima di stringere il CHECK, riallinea i dati esistenti: 'sdi_consultation' (unico
-- valore vivo, scritto da services/sdiConsultation.js) diventa 'acube'.
UPDATE company_expenses SET source = 'acube' WHERE source = 'sdi_consultation';

-- Verificato dal vivo sul DB reale (non solo per grep sul codice): esiste UNA riga
-- con source='sdi_auto' (id 35d873e4-15aa-4d91-9595-91a7a690cdf4, company "QA Ladia
-- Single Retry", sdi_invoice_id sintetico "inv_ladia_single_..."), residuo di un test
-- diretto della funzione ingestMappedExpense sul path Openapi, mai passato dal webhook
-- reale (che oggi non può nemmeno partire: OPENAPI_API_KEY non è mai stata
-- configurata). Non è dato fiscale di un cliente reale — la riportiamo a 'manual',
-- l'unico bucket generico dei tre nuovi valori, senza perdere informazione: il campo
-- notes della riga descrive già la provenienza originale ("Importata automaticamente
-- da fattura elettronica (SdI)").
UPDATE company_expenses SET source = 'manual' WHERE source = 'sdi_auto';

ALTER TABLE company_expenses DROP CONSTRAINT IF EXISTS company_expenses_source_check;
ALTER TABLE company_expenses ADD CONSTRAINT company_expenses_source_check
  CHECK (source IN ('manual', 'acube', 'email'));

-- ── Nuove colonne per il canale email (e per note di credito, utili a tutti i canali) ──
ALTER TABLE company_expenses
  ADD COLUMN IF NOT EXISTS content_hash        text,    -- sha256 del contenuto XML estratto — dedup a livello DB
  ADD COLUMN IF NOT EXISTS source_email        text,    -- mittente originale dell'email (canale 'email')
  ADD COLUMN IF NOT EXISTS source_message_id   text,    -- Message-Id originale, per tracciare a ritroso in email_ingest_log
  ADD COLUMN IF NOT EXISTS sdi_document_type   text,    -- TipoDocumento FatturaPA (TD01, TD04, ...)
  ADD COLUMN IF NOT EXISTS is_credit_note      boolean NOT NULL DEFAULT false, -- TD04 e affini: da sottrarre in aggregazione, non sommare
  ADD COLUMN IF NOT EXISTS pending_review      boolean NOT NULL DEFAULT false, -- possibile doppione di una spesa OCR manuale, in attesa di scelta utente
  ADD COLUMN IF NOT EXISTS pending_review_reason text;

-- Stesso documento arrivato due volte in formati diversi (XML e p7m dello stesso
-- contenuto, o stessa email ritentata) ha hash diversi solo se il contenuto binario
-- cambia — qui l'hash è calcolato sul contenuto XML estratto, quindi coincide anche
-- tra formati diversi dello stesso documento.
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_content_hash
  ON company_expenses(company_id, content_hash) WHERE content_hash IS NOT NULL;

-- ── Configurazione per company: indirizzo dedicato e stato del canale ───────────
CREATE TABLE IF NOT EXISTS email_ingest_configurations (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inbound_token             text        NOT NULL UNIQUE, -- parte locale dell'indirizzo: <token>@fatture.palladia.it
  status                    text        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'disabled')),
  last_invoice_received_at  timestamptz,
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id)
);

ALTER TABLE email_ingest_configurations ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_ingest_configurations_rw ON email_ingest_configurations FOR ALL
  USING (is_company_member(company_id));

-- ── Allowlist mittenti per company ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_ingest_allowed_senders (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email_address text        NOT NULL,
  action        text        NOT NULL CHECK (action IN ('allow', 'block')),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, email_address)
);

ALTER TABLE email_ingest_allowed_senders ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_ingest_allowed_senders_rw ON email_ingest_allowed_senders FOR ALL
  USING (is_company_member(company_id));

-- ── Registro di ogni messaggio ricevuto, accettato o no ──────────────────────────
-- company_id nullable: un token sconosciuto nel destinatario non risolve nessuna
-- company, ma il messaggio va comunque registrato (mai scarto silenzioso). Le righe
-- con company_id null non sono leggibili da nessun tenant via RLS — solo da service
-- role, per diagnostica interna.
CREATE TABLE IF NOT EXISTS email_ingest_log (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid        REFERENCES companies(id) ON DELETE CASCADE,
  inbound_token_used    text,
  from_address          text,
  subject               text,
  message_id            text,
  spf_result            text,
  dkim_result           text,
  size_bytes            integer,
  attachment_filenames  jsonb,
  outcome               text        NOT NULL CHECK (outcome IN (
                          'accepted', 'quarantined_unknown_sender', 'quarantined_failed_auth',
                          'rejected_size', 'rejected_type', 'duplicate', 'pending_review',
                          'sdi_metadata_skipped', 'unknown_token', 'error'
                        )),
  reject_reason         text,
  created_expense_ids   jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE email_ingest_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_ingest_log_r ON email_ingest_log FOR SELECT
  USING (company_id IS NOT NULL AND is_company_member(company_id));

CREATE INDEX IF NOT EXISTS idx_email_ingest_log_company ON email_ingest_log(company_id, created_at DESC);
