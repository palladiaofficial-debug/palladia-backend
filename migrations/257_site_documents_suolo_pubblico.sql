-- 257 — F-392 (AUDIT.md del frontend): la concessione di occupazione del suolo
-- pubblico come documento del cantiere («fai solo la parte piccola», il titolare,
-- 21/10). Caricata dalla scheda del cantiere, porta la scadenza in
-- sites.suolo_occupazione_end e Da fare avvisa 10 giorni prima per la proroga.
ALTER TABLE site_documents DROP CONSTRAINT IF EXISTS site_documents_category_check;
ALTER TABLE site_documents ADD CONSTRAINT site_documents_category_check
  CHECK (category IN ('pos', 'psc', 'notifica_asl', 'durc', 'dvr', 'assicurazione', 'contratto', 'capitolato', 'suolo_pubblico', 'altro'));
