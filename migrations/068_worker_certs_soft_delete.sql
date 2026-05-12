-- Migration 068: Soft delete per worker_certificates
-- I certificati hanno valore legale (D.Lgs 81/2008) e non devono essere
-- eliminati fisicamente. deleted_at = NULL significa "attivo".
ALTER TABLE worker_certificates ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Indice parziale: tutte le query normali filtrano WHERE deleted_at IS NULL
CREATE INDEX IF NOT EXISTS idx_worker_certs_active
  ON worker_certificates(company_id, worker_id)
  WHERE deleted_at IS NULL;
