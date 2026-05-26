-- Migration 084: aggiunge campo comune al cantiere per calcolo festività locali
-- Usato da calcEndDate per escludere il patrono comunale nei giorni lavorativi

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS comune TEXT DEFAULT NULL;

COMMENT ON COLUMN sites.comune IS 'Nome del comune del cantiere (es. Genova, Milano) — usato per escludere il Santo Patrono locale nei giorni lavorativi';
