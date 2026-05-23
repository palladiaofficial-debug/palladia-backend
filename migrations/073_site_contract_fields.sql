-- Migration 073: Gestione tempistica cantiere
-- Aggiunge: giorni contratto, tipo giorni, referente tecnico, occupazione suolo

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS contract_days       INTEGER,
  ADD COLUMN IF NOT EXISTS days_type           TEXT    DEFAULT 'solari'
                                               CHECK (days_type IN ('solari', 'lavorativi')),
  ADD COLUMN IF NOT EXISTS referente_tecnico_id UUID,
  ADD COLUMN IF NOT EXISTS referente_tecnico_name TEXT,
  ADD COLUMN IF NOT EXISTS suolo_occupazione        BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS suolo_occupazione_start  DATE,
  ADD COLUMN IF NOT EXISTS suolo_occupazione_end    DATE,
  ADD COLUMN IF NOT EXISTS suolo_occupazione_notes  TEXT;
