-- Migration 066: Studio CDL — gestione diretta imprese clienti
-- Il CDL può creare e gestire direttamente i profili delle imprese clienti
-- senza che l'impresa debba registrarsi su Palladia.
--
-- Architettura: il CDL è il data controller.
-- L'impresa è opzionale — può "reclamare" il proprio profilo in seguito.

-- studio_clients: flag che indica chi è il data controller
ALTER TABLE studio_clients
  ADD COLUMN IF NOT EXISTS owned_by_studio BOOLEAN NOT NULL DEFAULT false;

-- companies: traccia le aziende create direttamente da uno studio CDL
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS created_by_studio_id UUID REFERENCES studio_partners(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_companies_studio
  ON companies(created_by_studio_id)
  WHERE created_by_studio_id IS NOT NULL;

-- Indice per trovare rapidamente le imprese CDL-owned dato uno studio
CREATE INDEX IF NOT EXISTS idx_studio_clients_owned
  ON studio_clients(studio_id, owned_by_studio)
  WHERE owned_by_studio = true;
