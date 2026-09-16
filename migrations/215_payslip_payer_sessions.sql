-- 215_payslip_payer_sessions.sql
-- Sostituisce il sistema link+PIN per l'accesso pagamenti (migrazione 214)
-- con un magic link via email, stesso schema già collaudato in produzione
-- per il Portale Professionisti (coordinator_pro_sessions,
-- routes/v1/coordinatorPro.js).
--
-- Motivo del cambio (AUDIT.md, 2026-09-16): il sistema PIN era tecnicamente
-- corretto (verificato più volte dal vivo) ma nella pratica ha causato ore
-- di confusione reale — ogni "rigenera" crea un nuovo link, l'azienda deve
-- rincollarlo a mano su WhatsApp, il destinatario continuava ad aprire un
-- messaggio vecchio dalla stessa chat. Il titolare ha chiesto esplicitamente
-- "un sistema anche per gente che non ha mai avuto accesso a Palladia, un
-- accesso semplice e sicuro" — un link via email, click, dentro: nessun
-- secondo valore da copiare a mano, nessuna rigenerazione che rompe un
-- link già mandato, consegna diretta invece di un relay manuale via chat.

CREATE TABLE IF NOT EXISTS payslip_payer_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email        text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_payslip_payer_sessions_company ON payslip_payer_sessions (company_id);

ALTER TABLE payslip_payer_sessions ENABLE ROW LEVEL SECURITY;

-- Stesso principio di company_payer_access (migrazione 214): l'accesso
-- esterno passa per un endpoint pubblico verificato via token, non per una
-- query diretta col client Supabase.
CREATE POLICY payslip_payer_sessions_service_only ON payslip_payer_sessions
  FOR ALL USING (false) WITH CHECK (false);
