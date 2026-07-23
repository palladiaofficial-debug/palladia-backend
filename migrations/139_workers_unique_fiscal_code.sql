-- 139_workers_unique_fiscal_code.sql
-- F-014 / F-023 (audit 2026-07-22): nessun vincolo reale impediva di creare due
-- lavoratori con lo stesso codice fiscale nella stessa azienda. Sia workers.js
-- (409 WORKER_ALREADY_EXISTS su errore 23505) sia studio.js (upsert con
-- onConflict: 'company_id,fiscal_code') presupponevano già questo vincolo senza
-- che esistesse mai nello schema reale.
--
-- Vincolo UNIQUE pieno (non un indice parziale): supabase-js costruisce
-- ON CONFLICT (company_id, fiscal_code) senza predicato, che Postgres può
-- far combaciare solo con un vincolo/indice UNIQUE altrettanto senza predicato.
-- Righe con fiscal_code NULL restano comunque libere di coesistere: Postgres
-- non considera due NULL in conflitto tra loro in un vincolo UNIQUE standard.
--
-- Verificato prima di applicare: nessuna riga reale con fiscal_code duplicato
-- per la stessa company_id (solo righe con fiscal_code NULL, dati seed/demo).

ALTER TABLE workers
  ADD CONSTRAINT workers_company_fiscal_code_key UNIQUE (company_id, fiscal_code);
