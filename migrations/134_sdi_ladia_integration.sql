-- Migration 134: integrazione Ladia per le fatture fornitore automatiche (SdI)
-- 1. Realtime su company_expenses — la pagina Spese si aggiorna da sola quando
--    arriva una fattura, stesso pattern già in uso per pos_drafts (migrazione 126).
--    RLS già presente dalla 107 (company_expenses_rw, FOR ALL), nessuna nuova policy.
-- 2. Campo per la proposta di assegnazione cantiere generata da Ladia quando
--    ci sono più cantieri attivi e l'euristica deterministica non può decidere.

ALTER PUBLICATION supabase_realtime ADD TABLE company_expenses;

ALTER TABLE company_expenses
  ADD COLUMN IF NOT EXISTS suggested_site_id uuid REFERENCES sites(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS suggested_site_reason text;
