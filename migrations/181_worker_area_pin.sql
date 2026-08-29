-- 181_worker_area_pin.sql
-- F-102 (AUDIT.md): il login all'area lavoratore (buste paga/presenze) usava
-- il codice fiscale come unico fattore — calcolabile pubblicamente da nome +
-- data + luogo di nascita, dati che la stessa pagina badge deve mostrare per
-- permettere la verifica dell'ispettore. Sostituito con un PIN numerico
-- generato dall'amministratore, mostrato una sola volta in app (mai stampato
-- sul badge, mai esposto da un endpoint pubblico) e comunicato fuori banda al
-- lavoratore. Salvato come hash bcrypt (lib/pinHash.js, già esistente per
-- l'analogo PIN cantiere in scripts/set-site-pin.js) — mai in chiaro.

ALTER TABLE workers ADD COLUMN IF NOT EXISTS area_pin_hash text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS area_pin_set_at timestamptz;
