-- F-213 (AUDIT.md) — il caricamento DDT dei trasportatori interni
-- (routes/v1/badgeDdt.js) scrive su site_costs con tipo='ddt'. A differenza
-- di una fattura, un DDT quasi mai riporta un importo (le merci arrivano
-- prima del prezzo, che arriva solo con la fattura successiva) — imporre un
-- valore avrebbe significato inventare un numero per soddisfare un vincolo
-- pensato per le fatture, esattamente quello che l'azienda ci ha chiesto di
-- non fare mai su questi dati.
--
-- Verificato prima del cambio: i punti che sommano site_costs.importo
-- (routes/v1/economia.js, routes/v1/chat.js) usano Number(v.importo), che
-- su null restituisce 0 — un DDT senza prezzo non gonfia né altera nessun
-- totale esistente, semplicemente non contribuisce finché non arriva
-- l'importo reale (fattura di riscontro).

ALTER TABLE site_costs ALTER COLUMN importo DROP NOT NULL;

COMMENT ON COLUMN site_costs.importo IS 'NULL per i DDT (tipo=''ddt'') caricati prima che arrivi la fattura di riscontro — mai un valore inventato. Number(importo) su null vale 0 nelle somme, non altera i totali esistenti.';
