-- F-104 (AUDIT.md): approvare un mittente dalla quarantena non recuperava mai
-- l'email che l'aveva fatto comparire in lista — solo gli invii SUCCESSIVI
-- venivano importati, quella fattura specifica restava persa perché
-- email_ingest_log salvava solo nome file/mittente, mai il contenuto
-- dell'allegato. Queste colonne permettono di conservare gli allegati di un
-- messaggio quarantined_unknown_sender (in site-documents, stesso bucket già
-- usato da expenses.js/companyDocuments.js) e di registrare l'esito quando
-- vengono rielaborati dopo l'approvazione del mittente.

ALTER TABLE email_ingest_log
  ADD COLUMN IF NOT EXISTS quarantined_attachments jsonb,       -- [{filename, storage_path, size_bytes}], null se non conservati
  ADD COLUMN IF NOT EXISTS recovered_at             timestamptz,
  ADD COLUMN IF NOT EXISTS recovered_outcome        text,
  ADD COLUMN IF NOT EXISTS recovered_expense_ids    jsonb;
