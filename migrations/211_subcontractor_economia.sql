-- ================================================================
-- Migration 211 — economia per subappaltatore (F-188, AUDIT.md)
--
-- Richiesta esplicita del titolare: una tabella per ogni subappaltatore
-- con tutti i cantieri attivi con lui, appalto totale, acconti dati e
-- % di avanzamento — oggi un subappaltatore ha solo dati di conformità
-- (DURC/SOA/polizza) e un elenco di cantieri assegnati, zero euro
-- collegati. I pagamenti (site_costs) sono già tracciati per cantiere
-- ma con un campo `fornitore` libero, mai un vero collegamento al
-- subappaltatore che li ha ricevuti — impossibile sommarli in modo
-- affidabile per nessun subappaltatore.
--
-- Un subappaltatore lavora spesso su più cantieri con un accordo
-- economico SEPARATO per ciascuno (stesso subappaltatore, contratti
-- diversi) — l'appalto totale e la % di avanzamento vanno quindi sulla
-- COPPIA (site, subcontractor), non sul subappaltatore da solo: stesso
-- pattern già in uso per `sites.budget_totale`/`sites.sal_percentuale`
-- (routes/v1/economia.js), qui applicato a `site_subcontractors`, la
-- tabella che già rappresenta quella coppia.
--
-- Idempotente — ADD COLUMN IF NOT EXISTS.
-- ================================================================

ALTER TABLE site_subcontractors
  ADD COLUMN IF NOT EXISTS budget_totale numeric CHECK (budget_totale IS NULL OR budget_totale >= 0);

ALTER TABLE site_subcontractors
  ADD COLUMN IF NOT EXISTS sal_percentuale numeric NOT NULL DEFAULT 0
    CHECK (sal_percentuale >= 0 AND sal_percentuale <= 100);

-- Collegamento reale, non solo il testo libero `fornitore` già esistente
-- (che resta per compatibilità con i costi non attribuiti a un
-- subappaltatore specifico) — nullable: un costo generico di cantiere
-- non deve avere per forza un subappaltatore.
ALTER TABLE site_costs
  ADD COLUMN IF NOT EXISTS subcontractor_id uuid REFERENCES subcontractors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_site_costs_subcontractor
  ON site_costs (subcontractor_id) WHERE subcontractor_id IS NOT NULL;
