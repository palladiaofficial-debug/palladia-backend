-- 282 — F-509 (AUDIT.md del frontend): quanto rende ogni cantiere.
-- 1) Il tipo di lavoro del cantiere, per l'indice di congruità della manodopera
--    (DM 143/2021, tabella dell'Accordo collettivo del 10/9/2020). Il valore del
--    lavoro senza IVA resta in sites.budget_totale (già esistente).
-- 2) La memoria dei mesi già calcolati: il conto legge il prospetto contabile e
--    17 buste paga, troppo lento da rifare a ogni apertura della pagina.
--    Sono paghe: RLS accesa e nessuna policy, la legge solo il server.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS congruita_categoria text
  CHECK (congruita_categoria IS NULL OR congruita_categoria IN (
    'nuova_civile', 'nuova_industriale', 'ristrutturazione_civile', 'ristrutturazione_industriale',
    'restauro_tutelati', 'opere_stradali', 'sottosuolo', 'dighe', 'acquedotti_fognature', 'gasdotti',
    'oleodotti', 'irrigazione', 'marittime', 'fluviali', 'impianti_energia', 'impianti_distribuzione', 'bonifica'
  ));

CREATE TABLE IF NOT EXISTS quanto_rende_mesi (
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mese         text NOT NULL CHECK (mese ~ '^\d{4}-\d{2}$'),
  risultato    jsonb NOT NULL,
  calcolato_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, mese)
);
ALTER TABLE quanto_rende_mesi ENABLE ROW LEVEL SECURITY;
