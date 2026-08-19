-- Migration 166: aggiunge 'blocked_sender' agli esiti ammessi di email_ingest_log.
--
-- La migrazione 165 distingueva già 'quarantined_unknown_sender' (mittente mai
-- visto) da 'quarantined_failed_auth' (mittente noto ma SPF/DKIM falliti), ma non
-- aveva un esito dedicato per un mittente esplicitamente bloccato dall'utente
-- (azione "blocca" nell'interfaccia di quarantena) — serve per non confondere,
-- nel registro, "non lo conosciamo ancora" con "l'utente ha deciso di bloccarlo".

ALTER TABLE email_ingest_log DROP CONSTRAINT IF EXISTS email_ingest_log_outcome_check;
ALTER TABLE email_ingest_log ADD CONSTRAINT email_ingest_log_outcome_check
  CHECK (outcome IN (
    'accepted', 'quarantined_unknown_sender', 'quarantined_failed_auth', 'blocked_sender',
    'rejected_size', 'rejected_type', 'duplicate', 'pending_review',
    'sdi_metadata_skipped', 'unknown_token', 'error'
  ));
