-- Rimuove il canale "Codice Destinatario diretto" via Openapi (migrazioni 132/133) —
-- censito il 2026-08-22 (vedi AUDIT.md F-063) come codice morto: OPENAPI_API_KEY
-- mai configurata in produzione, nessuna riga company_expenses con source='sdi_auto'
-- mai scritta da un webhook reale, nessuna UI lo ha mai reso raggiungibile da un
-- titolare, e mapInvoiceResponseToExpense scriveva ancora 'sdi_auto' — valore non
-- più ammesso dal CHECK constraint company_expenses_source_check dalla 165 — quindi
-- si sarebbe rotto al primo uso reale. L'unica riga esistente in sdi_configurations
-- è un fixture di test (company "QA Ladia Single Retry", fiscal_id 'IT2').
--
-- Il codice applicativo (routes/v1/sdiInvoices.js, lib/schemas/sdiInvoices.js,
-- connectCompany/getConnectionStatus/disconnectCompany/mapInvoiceResponseToExpense/
-- ingestSupplierInvoice/confirmLegalStorage) è stato rimosso nella stessa modifica.
-- services/sdiInvoices.js resta come motore di ingest condiviso (ingestMappedExpense)
-- usato da email, consultazione A-Cube e importazione massiva.

DROP TABLE IF EXISTS sdi_configurations;
