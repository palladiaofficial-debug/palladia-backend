-- 172_documents_tier4_schema.sql
-- Fase 2, Scaglione 4 — passo "expand". Estende `documents` per coprire
-- equipment_documents (mezzi/attrezzature) — backend pronto da mesi
-- (routes/v1/equipment.js) ma mai collegato a nessuna interfaccia.
-- Puramente additivo: nessuna colonna esistente viene rimossa o ristretta.

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_owner_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_owner_type_check
  CHECK (owner_type IN ('site','company','worker','subcontractor','equipment'));

ALTER TABLE documents ADD COLUMN IF NOT EXISTS equipment_id uuid REFERENCES equipment(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_documents_equipment ON documents(equipment_id) WHERE equipment_id IS NOT NULL;
