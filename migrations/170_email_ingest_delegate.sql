-- Migration 170: delega a terzi per l'inoltro del canale fatture via email.
--
-- Non tutti i titolari configurano la PEC di persona: nella maggior parte delle
-- imprese lo fa l'amministrativa, il commercialista o un familiare. Questa
-- colonna traccia SE e QUANDO le istruzioni sono state inviate a un indirizzo
-- esterno, così il titolare vede uno stato reale ("istruzioni inviate a
-- mario@studio.it il 12 settembre") invece di restare nel dubbio se l'ha fatto
-- o no. Non richiede un account Palladia lato delegato — l'email stessa contiene
-- tutto il necessario (vedi services/email.js → sendEmailIngestDelegateInstructions).

ALTER TABLE email_ingest_configurations
  ADD COLUMN IF NOT EXISTS delegate_email                text,
  ADD COLUMN IF NOT EXISTS delegate_provider              text,
  ADD COLUMN IF NOT EXISTS delegate_instructions_sent_at  timestamptz;
