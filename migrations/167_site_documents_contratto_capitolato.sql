-- Migration 167: aggiunge 'contratto' e 'capitolato' alle categorie ammesse
-- su site_documents.
--
-- Un contratto o capitolato caricato come documento generico finiva sempre
-- silenziosamente rietichettato 'altro' — sia dal CHECK della tabella (che
-- non ammetteva questi due valori) sia dalla CATEGORY_ALLOWLIST lato
-- applicativo in services/smartImportPipeline.js (fix nello stesso commit).
-- Non blocca la lettura via Ladia (leggi_documento_pdf non filtra per
-- categoria — è solo un boost di punteggio, vedi services/ladiaDocumentSearch.js),
-- ma sporca la navigazione/ricerca per tipo nell'interfaccia.

ALTER TABLE site_documents DROP CONSTRAINT IF EXISTS site_documents_category_check;
ALTER TABLE site_documents ADD CONSTRAINT site_documents_category_check
  CHECK (category IN ('pos', 'psc', 'notifica_asl', 'durc', 'dvr', 'assicurazione', 'contratto', 'capitolato', 'altro'));
