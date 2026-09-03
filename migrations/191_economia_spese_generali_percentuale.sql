-- 191_economia_spese_generali_percentuale.sql
-- BLOCCO 5 — Livello aziendale: spese generali (ufficio, assicurazioni, mezzi,
-- amministrazione) allocate ai cantieri con una percentuale unica, configurata
-- una volta dal titolare. Applicata al budget di ogni cantiere (stesso
-- principio di trasparenza del moltiplicatore costo-manodopera, migrazione
-- 189: mai un valore implicito, sempre mostrato in chiaro con spiegazione) —
-- non un tentativo di ripartire algoritmicamente company_recurring_expenses
-- (richiederebbe una base di riparto arbitraria: per budget? per giorni
-- attivi? per maturato? — il titolare conosce già la propria incidenza dei
-- costi fissi sul fatturato meglio di qualunque euristica).

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS percentuale_spese_generali numeric(5,2) NOT NULL DEFAULT 0
    CHECK (percentuale_spese_generali >= 0 AND percentuale_spese_generali <= 100);

COMMENT ON COLUMN companies.percentuale_spese_generali IS
  'Percentuale del budget di ogni cantiere allocata a copertura delle spese generali aziendali (ufficio, assicurazioni, mezzi, amministrazione). Configurata una volta dal titolare, non calcolata automaticamente. Default 0 = nessuna allocazione finché non impostata esplicitamente. Sempre mostrata in chiaro accanto al margine netto che genera, mai un valore implicito nel calcolo.';
