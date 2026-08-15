-- ================================================================
-- Migration 163 — import_items.extra_site_id: cantiere extra per Importazione
-- Intelligente (Cartelle Intelligenti, vedi AUDIT.md)
--
-- smartImportAI.js estrae già "site_hint" per OGNI documento (non solo
-- site_documents) ma smartImportPipeline.js lo usava solo per destination=
-- site_documents. Questa colonna porta il cantiere abbinato (via matchSite,
-- stessa logica già in uso) fino alla conferma, per i documenti di un
-- lavoratore che riguardano anche un cantiere specifico (es. un attestato di
-- formazione con il nome del cantiere nel testo).
-- ================================================================

ALTER TABLE import_items ADD COLUMN IF NOT EXISTS extra_site_id uuid REFERENCES sites(id);
