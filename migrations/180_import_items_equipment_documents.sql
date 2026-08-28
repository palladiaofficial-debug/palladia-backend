-- 180_import_items_equipment_documents.sql
-- F-096 (AUDIT.md): estende l'Importazione Intelligente (import ZIP/cartella)
-- con la stessa destinazione equipment_documents già aggiunta all'archiviazione
-- diretta da chat (F-095) — un libretto di circolazione/assicurazione/revisione
-- importato in blocco ora può finire sulla scheda del mezzo giusto invece che
-- genericamente in company_documents.

ALTER TABLE import_items DROP CONSTRAINT IF EXISTS import_items_destination_check;
ALTER TABLE import_items ADD CONSTRAINT import_items_destination_check
  CHECK (destination IN ('site_documents', 'company_documents', 'worker_documents', 'worker_certificates', 'payslips', 'equipment_documents'));

-- Stesso pattern di matched_worker_id/matched_site_id (migrazione 136) —
-- nessuna colonna staged_equipment_id: un mezzo senza corrispondenza non
-- viene proposto in creazione (troppi campi obbligatori da dedurre in modo
-- affidabile da un documento scansionato), resta in pending_review.
ALTER TABLE import_items ADD COLUMN IF NOT EXISTS matched_equipment_id uuid REFERENCES equipment(id) ON DELETE SET NULL;
ALTER TABLE import_items ADD COLUMN IF NOT EXISTS equipment_match_score int;
