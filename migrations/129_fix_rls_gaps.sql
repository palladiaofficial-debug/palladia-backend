-- Migration 129: chiude una falla di isolamento multi-tenant su larga scala
--
-- Scoperta il 2026-07-09 durante un test manuale della checklist di lancio:
-- navigando su /cantieri/<uuid di un'altra company> l'app mostrava dati reali
-- del cantiere sbagliato. Causa: la tabella `sites` in produzione aveva
-- relrowsecurity=false (RLS disabilitato), nonostante la migrazione 002 lo
-- avesse abilitato — probabilmente disattivato manualmente da SQL Editor
-- durante debug e mai riattivato, senza che nessuna migrazione tracciasse
-- il rollback.
--
-- Un audit sistematico di TUTTE le tabelle (pg_class.relrowsecurity +
-- pg_policies) ha trovato lo stesso problema su altre 23 tabelle, incluse
-- workers, presence_logs, worksite_workers, worker_device_sessions,
-- chat_conversations, chat_messages, site_documents, subcontractors — più
-- la policy companies_select alterata a `USING (true)` (chiunque autenticato
-- legge tutte le company). SUPABASE_URL/ANON_KEY sono pubblici (GET
-- /api/config, vedi migrazione 123 per un caso analogo), quindi qualunque
-- utente con un account Palladia poteva leggere (e in molti casi
-- scrivere/cancellare) i dati di TUTTE le altre company via REST API diretta,
-- bypassando completamente il backend.
--
-- Il fatto che il backend filtri correttamente per company_id non basta:
-- moltissime query (frontend + script) vanno dirette a Supabase con la
-- sola RLS come barriera.

-- ──────────────────────────────────────────────────────────────
-- companies — la policy live divergeva dalla migrazione 002
-- ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "companies_select" ON companies;
CREATE POLICY "companies_select" ON companies
  FOR SELECT USING (is_company_member(id));

-- company_users — ripristina la clausola OR mancante (migrazione 002)
DROP POLICY IF EXISTS "cu_select" ON company_users;
CREATE POLICY "cu_select" ON company_users
  FOR SELECT USING (user_id = auth.uid() OR is_company_member(company_id));

-- ──────────────────────────────────────────────────────────────
-- Tabelle core (migrazione 002) — RLS risultava disabilitato in produzione
-- nonostante la migrazione lo avesse abilitato. Ripristina RLS + policy
-- originali esattamente come definite in 002_multi_tenant.sql.
-- ──────────────────────────────────────────────────────────────
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sites_select" ON sites;
DROP POLICY IF EXISTS "sites_insert" ON sites;
DROP POLICY IF EXISTS "sites_update" ON sites;
CREATE POLICY "sites_select" ON sites
  FOR SELECT USING (company_id IS NULL OR is_company_member(company_id));
CREATE POLICY "sites_insert" ON sites
  FOR INSERT WITH CHECK (is_company_member(company_id));
CREATE POLICY "sites_update" ON sites
  FOR UPDATE USING (is_company_member(company_id));

ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workers_select" ON workers;
DROP POLICY IF EXISTS "workers_insert" ON workers;
DROP POLICY IF EXISTS "workers_update" ON workers;
CREATE POLICY "workers_select" ON workers
  FOR SELECT USING (is_company_member(company_id));
CREATE POLICY "workers_insert" ON workers
  FOR INSERT WITH CHECK (is_company_member(company_id));
CREATE POLICY "workers_update" ON workers
  FOR UPDATE USING (is_company_member(company_id));

ALTER TABLE worksite_workers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ww_select" ON worksite_workers;
DROP POLICY IF EXISTS "ww_insert" ON worksite_workers;
DROP POLICY IF EXISTS "ww_update" ON worksite_workers;
CREATE POLICY "ww_select" ON worksite_workers
  FOR SELECT USING (is_company_member(company_id));
CREATE POLICY "ww_insert" ON worksite_workers
  FOR INSERT WITH CHECK (is_company_member(company_id));
CREATE POLICY "ww_update" ON worksite_workers
  FOR UPDATE USING (is_company_member(company_id));

ALTER TABLE worker_device_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sessions_select" ON worker_device_sessions;
CREATE POLICY "sessions_select" ON worker_device_sessions
  FOR SELECT USING (is_company_member(company_id));

-- presence_logs — append-only per design: SELECT + INSERT, mai UPDATE/DELETE
ALTER TABLE presence_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "presence_select" ON presence_logs;
DROP POLICY IF EXISTS "presence_insert" ON presence_logs;
CREATE POLICY "presence_select" ON presence_logs
  FOR SELECT USING (is_company_member(company_id));
CREATE POLICY "presence_insert" ON presence_logs
  FOR INSERT WITH CHECK (is_company_member(company_id));

-- ──────────────────────────────────────────────────────────────
-- Tabelle create senza mai abilitare RLS (nessuna migrazione lo
-- prevedeva — gap fin dalla creazione, non una regressione).
-- Pattern "FOR ALL" identico a pos_documents_company_access, l'unica
-- tabella multi-tenant che risultava già corretta in produzione.
-- ──────────────────────────────────────────────────────────────
ALTER TABLE company_prezzi ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company_prezzi_access" ON company_prezzi
  FOR ALL USING (is_company_member(company_id));

ALTER TABLE coordinator_visits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "coordinator_visits_access" ON coordinator_visits
  FOR ALL USING (is_company_member(company_id));

ALTER TABLE ladia_document_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ladia_document_templates_access" ON ladia_document_templates
  FOR ALL USING (is_company_member(company_id));

ALTER TABLE ladia_proactive_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ladia_proactive_log_access" ON ladia_proactive_log
  FOR ALL USING (is_company_member(company_id));

ALTER TABLE site_coordinator_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "site_coordinator_invites_access" ON site_coordinator_invites
  FOR ALL USING (is_company_member(company_id));

ALTER TABLE site_coordinator_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "site_coordinator_notes_access" ON site_coordinator_notes
  FOR ALL USING (is_company_member(company_id));

ALTER TABLE site_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "site_documents_access" ON site_documents
  FOR ALL USING (is_company_member(company_id));

ALTER TABLE site_nonconformities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "site_nonconformities_access" ON site_nonconformities
  FOR ALL USING (is_company_member(company_id));

ALTER TABLE subcontractors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "subcontractors_access" ON subcontractors
  FOR ALL USING (is_company_member(company_id));

ALTER TABLE user_site_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_site_assignments_access" ON user_site_assignments
  FOR ALL USING (is_company_member(company_id));

-- ──────────────────────────────────────────────────────────────
-- Ladia: conversazioni/cartelle personali — per-utente, non solo per-company
-- (il backend le filtra sempre con company_id + user_id, tranne la vista
-- "team" per i manager, che passa dal backend con service-role e quindi
-- bypassa comunque RLS)
-- ──────────────────────────────────────────────────────────────
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chat_conversations_access" ON chat_conversations
  FOR ALL USING (is_company_member(company_id) AND user_id = auth.uid());

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chat_messages_access" ON chat_messages
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM chat_conversations c
      WHERE c.id = chat_messages.conversation_id
        AND is_company_member(c.company_id)
        AND c.user_id = auth.uid()
    )
  );

ALTER TABLE ladia_folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ladia_folders_access" ON ladia_folders
  FOR ALL USING (is_company_member(company_id) AND user_id = auth.uid());

-- ──────────────────────────────────────────────────────────────
-- Tabelle non multi-tenant: dati globali condivisi o accesso solo da
-- backend con service-role. Basta abilitare RLS senza policy per
-- authenticated/anon: si blocca ogni accesso diretto dal client,
-- il backend continua a funzionare perché usa la service key (bypassa RLS).
-- ──────────────────────────────────────────────────────────────
ALTER TABLE attendance                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE coordinator_pro_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE coordinator_profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_coordinator_links     ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_coordinator_link_codes ENABLE ROW LEVEL SECURITY;

-- prezzario_voci — listino prezzi regionale condiviso tra tutte le company,
-- non per-tenant per design. Sola lettura per utenti autenticati.
ALTER TABLE prezzario_voci ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prezzario_voci_select" ON prezzario_voci
  FOR SELECT USING (auth.role() = 'authenticated');
