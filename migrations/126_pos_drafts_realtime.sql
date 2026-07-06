-- Migration 126 — pos_drafts: RLS + Realtime
--
-- Serve per una sola cosa: far funzionare il wizard POS in tempo reale.
-- Oggi il wizard legge pos_drafts UNA VOLTA al mount (POSGenerator.tsx) e
-- resta fermo se Ladia scrive dati mentre la pagina è già aperta altrove —
-- l'utente deve ricaricare per vedere gli aggiornamenti. La sottoscrizione
-- Supabase Realtime lato client (anon key) richiede RLS per rispettare
-- l'isolamento multi-tenant — pos_drafts non ne aveva ancora bisogno perché
-- finora veniva letta solo tramite l'endpoint backend (service key, bypassa
-- RLS). Solo SELECT: le scritture restano lato backend/service-role.
--
-- Riusa is_company_member(), già definita in 002_multi_tenant.sql — stesso
-- pattern di sites/companies/pos_documents, nessuna funzione nuova.

ALTER TABLE pos_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY pos_drafts_select ON pos_drafts
  FOR SELECT USING (is_company_member(company_id));

ALTER PUBLICATION supabase_realtime ADD TABLE pos_drafts;
