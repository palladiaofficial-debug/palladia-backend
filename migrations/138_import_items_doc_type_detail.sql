-- Migration 138 — Importazione Intelligente: tipo corso granulare per il matching course_type_id
-- La classificazione usa un enum grezzo (attestato_formazione), ma per
-- collegare un worker_certificate al corso giusto in course_types serve il
-- tipo granulare che l'estrazione already restituisce (WORKER_DOC_PROMPT:
-- formazione_sicurezza|primo_soccorso|antincendio|...) e che finora veniva
-- scartato — risultato: i certificati creati dall'import non comparivano
-- nella pagina Documenti/Formazione (raggruppata per course_type_id).
-- Trovato col test end-to-end via Playwright.

ALTER TABLE import_items ADD COLUMN IF NOT EXISTS doc_type_detail text;
