-- Migration 137 — Importazione Intelligente: trigger updated_at + contatori atomici
-- Il recovery job (reclaimStuckItems) si basa su import_items.updated_at per
-- capire da quanto un item è fermo in 'processing' — serve un trigger, non
-- basta il default a created_at. I contatori di progresso (processed_files/
-- total_files) sono incrementati da chiamate concorrenti (CONCURRENCY=3): un
-- read-then-write in JS avrebbe una race, quindi qui vanno via RPC atomica.

CREATE OR REPLACE FUNCTION _import_items_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_import_items_updated_at ON import_items;
CREATE TRIGGER trg_import_items_updated_at
  BEFORE UPDATE ON import_items
  FOR EACH ROW EXECUTE FUNCTION _import_items_set_updated_at();

CREATE OR REPLACE FUNCTION _import_batches_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_import_batches_updated_at ON import_batches;
CREATE TRIGGER trg_import_batches_updated_at
  BEFORE UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION _import_batches_set_updated_at();

CREATE OR REPLACE FUNCTION increment_import_batch_processed(p_batch_id uuid)
RETURNS void LANGUAGE sql AS $$
  UPDATE import_batches SET processed_files = processed_files + 1 WHERE id = p_batch_id;
$$;

CREATE OR REPLACE FUNCTION increment_import_batch_total(p_batch_id uuid, p_delta int)
RETURNS void LANGUAGE sql AS $$
  UPDATE import_batches SET total_files = total_files + p_delta WHERE id = p_batch_id;
$$;
