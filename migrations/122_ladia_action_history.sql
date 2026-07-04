-- Migration 122: ladia_action_history — undo reale per le scritture di Ladia.
-- Diversa da admin_audit_log (append-only, trail legale immutabile): questa
-- tabella è pensata per essere marcata "annullata" dopo un rollback, quindi
-- NON è append-only. Il trail legale in admin_audit_log resta comunque
-- invariato — l'undo produce una NUOVA riga di log lì (azione "undo" a sé),
-- non cancella la storia.

CREATE TABLE IF NOT EXISTS ladia_action_history (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id            uuid        NOT NULL,
  conversation_id    uuid        REFERENCES chat_conversations(id) ON DELETE SET NULL,
  resource           text        NOT NULL,                          -- nome risorsa nel registro (es. 'workers')
  table_name         text        NOT NULL,
  pk_column          text        NOT NULL,
  record_id          text        NOT NULL,
  action             text        NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  previous_values    jsonb,                                          -- update: valori prima del cambio
  changed_fields     jsonb,                                          -- update: solo i nomi/valori nuovi dei campi toccati (per il controllo conflitti)
  full_row_snapshot  jsonb,                                          -- delete: riga intera, per poterla reinserire
  summary            text        NOT NULL,                           -- descrizione leggibile per il bottone "Annulla"
  created_at         timestamptz NOT NULL DEFAULT now(),
  undone_at          timestamptz,
  undone_by          uuid
);

CREATE INDEX IF NOT EXISTS idx_ladia_action_history_company ON ladia_action_history(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ladia_action_history_record   ON ladia_action_history(table_name, record_id);

ALTER TABLE ladia_action_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ladia_action_history_company ON ladia_action_history;
CREATE POLICY ladia_action_history_company ON ladia_action_history
  FOR ALL USING (is_company_member(company_id));
