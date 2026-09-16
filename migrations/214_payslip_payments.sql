-- 214_payslip_payments.sql
-- Sistema leggero per condividere la lista buste paga con chi fa i bonifici
-- (spesso uno studio/professionista esterno, non un utente Palladia) e
-- tenere traccia di cosa è stato pagato. Richiesto esplicitamente dal
-- titolare ("condividere la lista delle buste divise per lavoratore a chi
-- paga... e segnare se sono state pagate").
--
-- Stesso pattern di autenticazione dell'area lavoratore (migrazione 181,
-- F-102): un codice di accesso nell'URL + un PIN a 6 cifre generato
-- dall'amministratore, mai esposto in chiaro se non al momento della
-- generazione. Tabella separata (non colonne su companies) per isolare il
-- concern e restare coerenti col fatto che è un accesso per-azienda, non
-- per-utente Palladia.

CREATE TABLE IF NOT EXISTS company_payer_access (
  company_id   uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  access_code  text UNIQUE NOT NULL,
  pin_hash     text,
  pin_set_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE company_payer_access ENABLE ROW LEVEL SECURITY;

-- Nessuna policy per anon/authenticated: l'accesso esterno passa per un
-- endpoint pubblico verificato via PIN (come /api/v1/area/:code/auth), non
-- per una query diretta col client Supabase — stesso schema di sicurezza di
-- workers.area_pin_hash, mai leggibile via RLS pubblica.
CREATE POLICY company_payer_access_service_only ON company_payer_access
  FOR ALL USING (false) WITH CHECK (false);

ALTER TABLE payslips ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'da_pagare'
  CHECK (payment_status IN ('da_pagare', 'pagata'));
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS paid_by text CHECK (paid_by IN ('company', 'payer'));
