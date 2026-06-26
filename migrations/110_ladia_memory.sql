-- Migration 110: ladia_memory
-- Memoria persistente di Ladia per cantiere e per utente.
-- Ladia accumula fatti strutturati da conversazioni, note, documenti.

CREATE TABLE IF NOT EXISTS ladia_memory (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type text        NOT NULL CHECK (entity_type IN ('site', 'user')),
  entity_id   uuid        NOT NULL,
  content     text        NOT NULL DEFAULT '',
  updated_at  timestamptz DEFAULT now(),
  UNIQUE (company_id, entity_type, entity_id)
);

ALTER TABLE ladia_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ladia_memory_company_access" ON ladia_memory
  FOR ALL USING (is_company_member(company_id));

-- metadata su notifications (per suggerimenti Ladia)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS metadata jsonb;

-- Index per lookup veloci
CREATE INDEX IF NOT EXISTS ladia_memory_site_idx ON ladia_memory (company_id, entity_id) WHERE entity_type = 'site';
CREATE INDEX IF NOT EXISTS ladia_memory_user_idx ON ladia_memory (company_id, entity_id) WHERE entity_type = 'user';
