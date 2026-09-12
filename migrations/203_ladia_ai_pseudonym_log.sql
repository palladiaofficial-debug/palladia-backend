-- ================================================================
-- Migration 203 — registro tecnico della pseudonimizzazione (F-177,
-- AUDIT.md). Una riga per turno di chat Ladia che ha coinvolto
-- almeno un lavoratore: prova consultabile, in caso di controllo,
-- che la sostituzione nome/id->codice (F-176) è stata applicata
-- davvero ad ogni chiamata reale, non solo "il codice dice che
-- dovrebbe". Deliberatamente NON contiene gli id/nomi coinvolti,
-- solo un conteggio — non deve diventare esso stesso un canale di
-- dati personali.
-- ================================================================

CREATE TABLE IF NOT EXISTS ladia_ai_pseudonym_log (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  conversation_id   uuid        REFERENCES chat_conversations(id) ON DELETE SET NULL,
  model             text        NOT NULL,
  workers_involved  integer     NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ladia_ai_pseudonym_log_company_created ON ladia_ai_pseudonym_log(company_id, created_at DESC);

ALTER TABLE ladia_ai_pseudonym_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ladia_ai_pseudonym_log_company ON ladia_ai_pseudonym_log;
CREATE POLICY ladia_ai_pseudonym_log_company ON ladia_ai_pseudonym_log
  FOR ALL USING (is_company_member(company_id));
