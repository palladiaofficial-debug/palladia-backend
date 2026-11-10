-- F-485 (AUDIT.md del frontend): «se un operaio esce alle 10, perché bisogna
-- aspettare le 10 per vedere se smette di piovere, segna pioggia tutto il
-- giorno». Regola dell'impresa, non di legge: ora limite (HH:MM) entro cui
-- un'uscita per pioggia vale come pioggia tutto il giorno. NULL = spenta
-- (conteggio normale: ore lavorate + il resto di pioggia).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pioggia_giorno_intero_entro time;

-- MSCedilizia S.r.l.: regola confermata dal datore di lavoro il 10/11/2026
UPDATE companies SET pioggia_giorno_intero_entro = '10:00'
WHERE id = '309e9018-1bcc-4876-9430-99cb89e043dd' AND pioggia_giorno_intero_entro IS NULL;

NOTIFY pgrst, 'reload schema';
