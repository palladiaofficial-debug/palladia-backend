-- Migration 051: tabella notifiche in-app per scadenze automatiche
-- Popolata dai cron giornalieri (equipment, worker docs, company docs).
-- UPSERT giornaliero: le notifiche si aggiornano ogni mattina.
-- read_by: array di user_id che hanno segnato la notifica come letta.

CREATE TABLE IF NOT EXISTS notifications (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type         text        NOT NULL,  -- 'worker_doc_expiry' | 'equipment_expiry' | 'company_doc_expiry'
  severity     text        NOT NULL DEFAULT 'info',  -- 'info' | 'warning' | 'critical'
  title        text        NOT NULL,
  body         text,
  entity_type  text,   -- 'worker_document' | 'equipment' | 'company_document'
  entity_id    uuid,
  read_by      uuid[]      NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, entity_type, entity_id, type)
);

CREATE INDEX IF NOT EXISTS idx_notifications_company
  ON notifications (company_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_entity
  ON notifications (entity_type, entity_id);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notifications_member" ON notifications;
CREATE POLICY "notifications_member"
  ON notifications FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));
