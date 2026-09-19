-- Migration 223: company_expenses.pagato_il — stesso trattamento già dato a
-- site_costs (086) e site_sal_history (087). Necessario per la pagina
-- Economia unificata: una spesa generale (affitto, assicurazione, o un DDT
-- su cantiere non censito, F-214) deve poter distinguere "registrata" da
-- "pagata davvero", esattamente come già succede per i costi di cantiere.

ALTER TABLE company_expenses ADD COLUMN IF NOT EXISTS pagato_il date;
