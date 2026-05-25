-- 082_pnl.sql
-- P&L per cantiere: tariffa oraria lavoratori + categoria costi diretti

-- Tariffa oraria → costo MO calcolato automaticamente dalle timbrature
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS tariffa_oraria NUMERIC(8,2);

-- Categoria costo (cosa si è comprato/pagato) distinta dal tipo documento
ALTER TABLE site_costs
  ADD COLUMN IF NOT EXISTS categoria TEXT;
