-- 153_documents_tier2_schema.sql
-- Fase 2, Scaglione 2 — passo "expand". Estende `documents` per coprire
-- subcontractor_documents e payslips, e chiude lo schema-gap di F-035
-- (AUDIT.md) aggiungendo content_hash a subcontractor_documents, l'unica
-- delle 5 tabelle "documento con file" a non averlo mai avuto.
--
-- Puramente additivo: nessuna colonna esistente viene rimossa o ristretta,
-- nessuna tabella storica perde dati.

-- ── F-035: subcontractor_documents non aveva mai avuto content_hash ─────────
-- Chiude il gap SCHEMA. Nota onesta: da sola non attiva un dedup all'upload —
-- nessun endpoint di upload diretto (nemmeno sulle altre 4 tabelle) controlla
-- content_hash oggi; è usato solo dalla pipeline di Importazione Intelligente,
-- che non include ancora subcontractor_documents tra le destinazioni valide
-- (import_items.destination, migrazione 136) — estendere quella whitelist è
-- una decisione a parte, non inclusa qui.
ALTER TABLE subcontractor_documents ADD COLUMN IF NOT EXISTS content_hash text;
CREATE INDEX IF NOT EXISTS idx_subcontractor_docs_content_hash
  ON subcontractor_documents(content_hash) WHERE content_hash IS NOT NULL;

-- ── documents: nuove colonne per Scaglione 2 ─────────────────────────────────
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_owner_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_owner_type_check
  CHECK (owner_type IN ('site','company','worker','subcontractor'));

ALTER TABLE documents ADD COLUMN IF NOT EXISTS subcontractor_id uuid REFERENCES subcontractors(id) ON DELETE CASCADE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS studio_id         uuid REFERENCES studio_partners(id) ON DELETE SET NULL;

-- solo payslips
ALTER TABLE documents ADD COLUMN IF NOT EXISTS period_year      smallint;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS period_month     smallint;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS payslip_status   text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS shared_at        timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS acknowledged_at  timestamptz;

CREATE INDEX IF NOT EXISTS idx_documents_subcontractor ON documents(subcontractor_id) WHERE subcontractor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_studio         ON documents(studio_id) WHERE studio_id IS NOT NULL;
