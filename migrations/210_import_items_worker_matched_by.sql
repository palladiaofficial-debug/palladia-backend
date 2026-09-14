-- ================================================================
-- Migration 210 — import_items.worker_matched_by (F-186, AUDIT.md)
--
-- L'Importazione Intelligente abbina un documento di un lavoratore
-- (worker_documents/worker_certificates/payslips) tramite
-- lib/entityMatch.js::matchWorker(): match ESATTO sul codice fiscale
-- (score 100, identificativo univoco) oppure, in mancanza, match
-- FUZZY sul nome (soglia 55/100 — due lavoratori con nomi simili, o
-- persino identici, possono confondersi). `worker_match_score` da
-- solo NON distingue i due casi: un nome scritto identico a un altro
-- candidato ottiene fuzzy score 100, indistinguibile da un vero match
-- CF. Richiesta esplicita del titolare prima di un carico reale di
-- buste paga ("non possiamo rischiare di caricare file... di altri
-- lavoratori") — serve poter negare la conferma automatica in blocco
-- ("Conferma tutti i verdi") a qualunque match non sia sul CF.
--
-- Idempotente — ADD COLUMN IF NOT EXISTS.
-- ================================================================

ALTER TABLE import_items ADD COLUMN IF NOT EXISTS worker_matched_by text;
