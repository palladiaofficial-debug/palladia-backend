-- Migration 111: ladia_objectives
-- Obiettivi e impegni tracciati da Ladia durante le conversazioni.
-- Permette a Ladia di fare follow-up su promesse/eventi/scadenze menzionati.

CREATE TABLE IF NOT EXISTS ladia_objectives (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id      uuid        REFERENCES sites(id) ON DELETE CASCADE,
  user_id      uuid,
  description  text        NOT NULL,
  due_date     date,
  status       text        NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'resolved', 'expired')),
  conv_id      uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE INDEX IF NOT EXISTS ladia_objectives_company_status
  ON ladia_objectives(company_id, status, due_date);

CREATE INDEX IF NOT EXISTS ladia_objectives_site_status
  ON ladia_objectives(site_id, status);

-- RLS
ALTER TABLE ladia_objectives ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company members can manage objectives"
  ON ladia_objectives
  USING (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));
