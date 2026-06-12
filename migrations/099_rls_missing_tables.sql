-- 099_rls_missing_tables.sql
-- Aggiunge Row Level Security sulle tabelle con dati sensibili che ne erano prive.
-- Usa la funzione is_company_member() già esistente (migration 002).

-- ── pos_documents ─────────────────────────────────────────────────────────────
ALTER TABLE pos_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pos_documents_company_access ON pos_documents;
CREATE POLICY pos_documents_company_access ON pos_documents
  FOR ALL USING (is_company_member(company_id));

-- ── company_invites ───────────────────────────────────────────────────────────
ALTER TABLE company_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_invites_company_access ON company_invites;
CREATE POLICY company_invites_company_access ON company_invites
  FOR ALL USING (is_company_member(company_id));

-- ── payslips ──────────────────────────────────────────────────────────────────
ALTER TABLE payslips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payslips_company_access ON payslips;
CREATE POLICY payslips_company_access ON payslips
  FOR ALL USING (is_company_member(company_id));

-- ── push_subscriptions ────────────────────────────────────────────────────────
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_own ON push_subscriptions;
CREATE POLICY push_subscriptions_own ON push_subscriptions
  FOR ALL USING (user_id = auth.uid());

-- ── site_setup_checklist ──────────────────────────────────────────────────────
ALTER TABLE site_setup_checklist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_setup_checklist_company_access ON site_setup_checklist;
CREATE POLICY site_setup_checklist_company_access ON site_setup_checklist
  FOR ALL USING (is_company_member(company_id));

-- ── company_documents ─────────────────────────────────────────────────────────
ALTER TABLE company_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_documents_company_access ON company_documents;
CREATE POLICY company_documents_company_access ON company_documents
  FOR ALL USING (is_company_member(company_id));

-- ── pos_acknowledgments ───────────────────────────────────────────────────────
-- Lavoratori (non autenticati) vi accedono tramite scan badge, quindi la policy
-- consente lettura ai member della company e inserimento al service_role.
ALTER TABLE pos_acknowledgments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pos_ack_company_read ON pos_acknowledgments;
CREATE POLICY pos_ack_company_read ON pos_acknowledgments
  FOR SELECT USING (is_company_member(company_id));

-- L'insert avviene tramite backend service_role (endpoint scan/acknowledge-pos),
-- quindi non serve policy INSERT per anon/authenticated.
