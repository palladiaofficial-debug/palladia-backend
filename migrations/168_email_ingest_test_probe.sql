-- Migration 168: verifica "invia email di prova" per il canale fatture via email.
--
-- Il pulsante di prova nell'interfaccia di attivazione manda un'email reale
-- attraverso Cloudflare Email Routing verso l'indirizzo dedicato dell'azienda, per
-- confermare che il canale funzioni davvero prima che l'utente ci si affidi con
-- fatture reali (vedi F-060 in AUDIT.md, milestone 9). Il nonce è la prova di
-- autenticità: solo il nostro backend può averlo generato, quindi il webhook lo
-- accetta ANCHE se il mittente reale (l'indirizzo envelope di Resend, imprevedibile
-- per via del VERP) non è in allowlist — l'autenticazione qui viene dal nonce nel
-- subject, non dall'identità del mittente.

ALTER TABLE email_ingest_configurations
  ADD COLUMN IF NOT EXISTS pending_test_nonce      text,
  ADD COLUMN IF NOT EXISTS pending_test_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_test_verified_at   timestamptz;

ALTER TABLE email_ingest_log DROP CONSTRAINT IF EXISTS email_ingest_log_outcome_check;
ALTER TABLE email_ingest_log ADD CONSTRAINT email_ingest_log_outcome_check
  CHECK (outcome IN (
    'accepted', 'quarantined_unknown_sender', 'quarantined_failed_auth', 'blocked_sender',
    'rejected_size', 'rejected_type', 'duplicate', 'pending_review',
    'sdi_metadata_skipped', 'unknown_token', 'error', 'test_ok'
  ));
