-- Migration 224: rimozione completa del modulo Controllo Economico (AUDIT.md
-- F-119, migrazioni 185-192) — mai attivato su nessuna azienda reale (dietro
-- flag economia_controllo_v1, solo MASTER_COMPANY_IDS), sostituito dalla
-- pagina Economia unificata (F-215) che legge direttamente site_costs/
-- company_expenses/site_sal_history/site_subcontractors — gli stessi dati
-- reali, senza passare da un registro intermedio mai validato.
--
-- Le triggers qui sotto giravano ad OGNI scrittura reale su company_expenses/
-- site_costs/site_computo/site_sal_history (tabelle vive, usate ogni giorno)
-- solo per alimentare un registro che nessuna azienda reale ha mai guardato —
-- rimosse qui, le tabelle sorgente e i loro dati non sono toccati.

-- ── Trigger su tabelle reali (le tabelle restano, i dati restano) ───────────
DROP TRIGGER IF EXISTS trg_sync_company_expenses_economia ON company_expenses;
DROP TRIGGER IF EXISTS trg_sync_site_costs_economia        ON site_costs;
DROP TRIGGER IF EXISTS trg_sync_site_computo_economia      ON site_computo;
DROP TRIGGER IF EXISTS trg_sync_site_sal_history_economia  ON site_sal_history;

-- ── Trigger sulle tabelle del modulo stesso (altrimenti le funzioni sotto non
-- si possono droppare prima di arrivare al DROP TABLE più in basso) ─────────
DROP TRIGGER IF EXISTS trg_sync_site_subcontracts_economia     ON site_subcontracts;
DROP TRIGGER IF EXISTS trg_sync_site_subcontract_sal_economia  ON site_subcontract_sal;

-- ── Funzioni di sync (non più referenziate da nessun trigger dopo quanto sopra) ──
DROP FUNCTION IF EXISTS sync_company_expenses_to_economia_movimenti();
DROP FUNCTION IF EXISTS sync_site_costs_to_economia_movimenti();
DROP FUNCTION IF EXISTS sync_site_computo_to_economia_movimenti();
DROP FUNCTION IF EXISTS sync_site_subcontracts_to_economia_movimenti();
DROP FUNCTION IF EXISTS sync_site_subcontract_sal_to_economia_movimenti();
DROP FUNCTION IF EXISTS sync_site_sal_history_to_economia_movimenti();
DROP FUNCTION IF EXISTS economia_categoria_da_testo(text);
DROP FUNCTION IF EXISTS sync_site_mo_consuntivo(uuid);
DROP FUNCTION IF EXISTS verify_economia_movimenti_sync();

-- ── Tabelle del modulo (foglie del grafo, come dichiarato nella 185 —
-- niente altro le referenzia) ────────────────────────────────────────────────
DROP TABLE IF EXISTS site_subcontract_sal;
DROP TABLE IF EXISTS site_subcontracts;
DROP TABLE IF EXISTS economia_sync_failures;
DROP TABLE IF EXISTS site_economia_movimenti;
DROP TABLE IF EXISTS economia_validazione_mensile;

-- ── Colonne su companies usate solo da questo modulo (moltiplicatore MO e
-- percentuale spese generali non sono mai state usate dal P&L reale in
-- routes/v1/economia.js, verificato prima di questa migrazione) ────────────
ALTER TABLE companies DROP COLUMN IF EXISTS moltiplicatore_costo_manodopera;
ALTER TABLE companies DROP COLUMN IF EXISTS percentuale_spese_generali;

-- ── Eventuali override del flag ormai inesistente ───────────────────────────
DELETE FROM company_feature_flags WHERE feature = 'economia_controllo_v1';
