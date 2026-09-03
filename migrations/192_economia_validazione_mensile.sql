-- 192_economia_validazione_mensile.sql
-- Strumento di confronto mensile richiesto esplicitamente dalla sezione
-- VALIDAZIONE del modulo Controllo Economico (AUDIT.md F-119): il modulo
-- resta dietro flag finché non si dimostrano 3 mesi consecutivi con
-- scostamento <5% tra il margine calcolato da Palladia e quello reale della
-- contabilità. "Prepara fin da subito uno strumento di confronto" — questa
-- tabella, non il Blocco 6 (predittivo), che resta esplicitamente rimandato
-- a dopo la validazione.

CREATE TABLE IF NOT EXISTS economia_validazione_mensile (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id           uuid          NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  mese              date          NOT NULL, -- sempre il giorno 1 del mese di riferimento
  margine_reale     numeric(14,2) NOT NULL, -- dalla contabilità reale, inserito a mano dal titolare
  margine_palladia  numeric(14,2) NOT NULL, -- snapshot del margine netto calcolato al momento dell'inserimento
  scostamento_pct   numeric(6,2)  NOT NULL, -- |reale - palladia| / |reale| * 100, calcolato e salvato (mai ricalcolato a partire da margine_reale=0)
  note              text,
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (site_id, mese)
);

CREATE INDEX IF NOT EXISTS idx_economia_validazione_company ON economia_validazione_mensile(company_id, mese DESC);
CREATE INDEX IF NOT EXISTS idx_economia_validazione_site ON economia_validazione_mensile(site_id, mese DESC);

ALTER TABLE economia_validazione_mensile ENABLE ROW LEVEL SECURITY;
CREATE POLICY economia_validazione_mensile_company_member ON economia_validazione_mensile
  FOR ALL USING (is_company_member(company_id))
  WITH CHECK    (is_company_member(company_id));
