-- ================================================================
-- Migration 162 — document_extra_homes: cartelle aggiuntive per un documento
--
-- Cartelle Intelligenti (vedi AUDIT.md): un documento visto nella UI a
-- cartelle ha sempre una "casa primaria" derivabile dalle colonne già
-- esistenti su `documents` (owner_type + site_id/worker_id + category) —
-- zero migrazione di dati. Questa tabella copre SOLO le case aggiuntive:
-- un DURC (company_documents, casa primaria = Azienda) che serve anche nel
-- fascicolo di 2 cantieri, un attestato di un lavoratore che vive anche nel
-- cantiere dove lavora oggi.
--
-- Non tocca le 5 tabelle storiche (restano l'unica fonte di verità, principio
-- già stabilito nella migrazione 150) — riferisce solo `documents.id`, la
-- tabella di lettura unificata già sincronizzata via trigger.
-- ================================================================

CREATE TABLE IF NOT EXISTS document_extra_homes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  folder_type  text NOT NULL CHECK (folder_type IN ('site', 'worker', 'category')),
  folder_key   text NOT NULL,  -- site_id / worker_id / category slug, sempre come testo
  added_by     text NOT NULL DEFAULT 'ladia',  -- 'ladia' oppure lo user_id di chi l'ha aggiunta a mano
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, folder_type, folder_key)
);

CREATE INDEX IF NOT EXISTS idx_document_extra_homes_folder ON document_extra_homes (folder_type, folder_key);
CREATE INDEX IF NOT EXISTS idx_document_extra_homes_document ON document_extra_homes (document_id);

ALTER TABLE document_extra_homes ENABLE ROW LEVEL SECURITY;

-- Stessa policy pattern delle altre tabelle di supporto sola-service-role
-- (es. ai_spend_alerts, migrazione 159) — accesso solo via service role
-- (tutti gli endpoint che la toccano passano da middleware/verifyJwt.js +
-- controllo esplicito su documents.company_id, non da RLS diretta lato client).
