-- 149_rls_documenti_mancanti.sql
-- Fix F-031 (AUDIT.md): worker_certificates, durc_records, studio_shared_documents,
-- studio_document_requests non avevano una policy RLS scoped su company_id.
--
-- Verificato dal vivo (scripts/selftest_rls_documenti.js) PRIMA di questa migrazione:
-- le 4 tabelle hanno RLS già abilitato a livello DB (probabilmente da un intervento
-- manuale via Supabase SQL editor mai catturato in una migrazione, coerente con
-- l'incidente RLS del 2026-07-09) ma SENZA alcuna policy — risultato: deny-all per
-- il ruolo authenticated, incluso l'accesso alle proprie righe. Non è quindi il leak
-- cross-tenant ipotizzato nel censimento (quello avrebbe richiesto RLS disabilitato),
-- ma è comunque un gap reale di coerenza rispetto alle tabelle gemelle
-- (worker_documents, company_documents, site_documents, subcontractor_documents,
-- payslips), tutte protette con lo stesso pattern is_company_member(company_id).
--
-- Il backend usa sempre il service-role key (bypassa RLS per definizione, vedi
-- lib/supabase.js) quindi questa migrazione non cambia il comportamento dell'app —
-- è difesa in profondità nel caso in cui un client diretto (Supabase JS lato
-- frontend, uno script, un futuro endpoint) usi mai l'anon key + JWT utente.

ALTER TABLE worker_certificates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "worker_certs_company_member" ON worker_certificates;
CREATE POLICY "worker_certs_company_member"
  ON worker_certificates FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

ALTER TABLE durc_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "durc_records_company_member" ON durc_records;
CREATE POLICY "durc_records_company_member"
  ON durc_records FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

ALTER TABLE studio_shared_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "studio_shared_docs_company_member" ON studio_shared_documents;
CREATE POLICY "studio_shared_docs_company_member"
  ON studio_shared_documents FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

ALTER TABLE studio_document_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "studio_doc_requests_company_member" ON studio_document_requests;
CREATE POLICY "studio_doc_requests_company_member"
  ON studio_document_requests FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));
