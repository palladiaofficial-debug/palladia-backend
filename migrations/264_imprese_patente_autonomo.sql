-- F-419 (AUDIT.md del frontend): «Pronta a lavorare».
-- Un lavoratore autonomo ha requisiti diversi da un'impresa (allegato XVII punto 2:
-- niente DVR né dichiarazione art. 14, sì attrezzature e DPI).
-- La classe SOA (letta dall'attestazione) esenta dalla patente a crediti se è III o più.
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS autonomo boolean NOT NULL DEFAULT false;
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS soa_classifica text;
