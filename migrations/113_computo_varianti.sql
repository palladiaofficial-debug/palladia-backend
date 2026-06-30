-- Migration 113: varianti e addendum al computo metrico
-- Retrocompatibile: tipo DEFAULT 'base', stato DEFAULT 'approvata'
-- I computi esistenti diventano automaticamente tipo='base', stato='approvata'.

ALTER TABLE site_computo
  ADD COLUMN IF NOT EXISTS tipo              TEXT NOT NULL DEFAULT 'base'
                                             CHECK (tipo IN ('base', 'variante')),
  ADD COLUMN IF NOT EXISTS numero_variante   INTEGER,          -- 1, 2, 3… per cantiere
  ADD COLUMN IF NOT EXISTS motivazione       TEXT,             -- motivazione variante
  ADD COLUMN IF NOT EXISTS stato             TEXT NOT NULL DEFAULT 'approvata'
                                             CHECK (stato IN ('bozza', 'approvata', 'in_attesa')),
  ADD COLUMN IF NOT EXISTS data_approvazione DATE;

-- Indice per filtrare per tipo
CREATE INDEX IF NOT EXISTS idx_site_computo_tipo
  ON site_computo(company_id, site_id, tipo);

-- Indice per ordinare varianti per numero
CREATE INDEX IF NOT EXISTS idx_site_computo_variante_num
  ON site_computo(site_id, numero_variante)
  WHERE tipo = 'variante';
