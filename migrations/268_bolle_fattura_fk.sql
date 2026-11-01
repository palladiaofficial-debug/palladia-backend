-- F-423: la bolla sa a quale fattura appartiene (per leggerle insieme e per lo stato
-- «la fattura non torna» nelle bolle del cantiere). Se la fattura sparisce, la bolla
-- torna «aspetto la fattura».
ALTER TABLE bolle DROP CONSTRAINT IF EXISTS bolle_fattura_fk;
ALTER TABLE bolle ADD CONSTRAINT bolle_fattura_fk FOREIGN KEY (fattura_id) REFERENCES fatture(id) ON DELETE SET NULL;
NOTIFY pgrst, 'reload schema';
