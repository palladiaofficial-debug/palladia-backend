-- 252 — F-357 (AUDIT.md del frontend): Da pagare, IBAN del fornitore.
-- Letto dalla fattura (XML: DettaglioPagamento/IBAN, dato certo; PDF/foto:
-- letto dall'IA e tenuto solo se il controllo ISO 13616 torna) e mostrato nel
-- dettaglio con la causale, da copiare nell'app della banca. Palladia non
-- paga e non tocca la banca.
ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS iban text;
