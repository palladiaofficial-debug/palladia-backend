-- Migration 169: indirizzo email leggibile (fatture-{slug-azienda}-{random}@palladia.net
-- invece di 24 caratteri esadecimali illeggibili) + tracciamento dei token
-- rigenerati/ritirati.
--
-- generateToken() ora costruisce l'inbound_token per intero (slug + parte
-- casuale) — nessuna modifica di schema serve per questo, la colonna esistente
-- resta un identificatore opaco unico, invariato nella forma.
--
-- Quello che serve davvero: quando un indirizzo viene rigenerato, il vecchio
-- token va ricordato — altrimenti un'email che arriva su un indirizzo appena
-- rigenerato finisce loggata come "token sconosciuto" generico, indistinguibile
-- da un indirizzo mai esistito. Con questa tabella il webhook può dare un
-- motivo esplicito ("questo indirizzo è stato rigenerato il [data]") invece di
-- uno generico.

CREATE TABLE IF NOT EXISTS email_ingest_retired_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token       text        NOT NULL,
  retired_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_ingest_retired_tokens_token ON email_ingest_retired_tokens(token);

ALTER TABLE email_ingest_retired_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_ingest_retired_tokens_rw ON email_ingest_retired_tokens FOR ALL
  USING (is_company_member(company_id));

ALTER TABLE email_ingest_log DROP CONSTRAINT IF EXISTS email_ingest_log_outcome_check;
ALTER TABLE email_ingest_log ADD CONSTRAINT email_ingest_log_outcome_check
  CHECK (outcome IN (
    'accepted', 'quarantined_unknown_sender', 'quarantined_failed_auth', 'blocked_sender',
    'rejected_size', 'rejected_type', 'duplicate', 'pending_review',
    'sdi_metadata_skipped', 'unknown_token', 'error', 'test_ok', 'token_retired'
  ));
