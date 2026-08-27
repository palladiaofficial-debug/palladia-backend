-- 179_rls_31_tabelle_senza_policy.sql
-- Fix F-090 (AUDIT.md): chiude l'ultima voce aperta di F-085/BLOCCO 1 — 31
-- tabelle con RLS attiva ma zero policy (deny-all silenzioso, non un leak:
-- nessuna di queste è mai interrogata dal frontend con l'anon key, il backend
-- usa sempre la service-role key). Formalizza una decisione esplicita per
-- ognuna delle 31, invece di lasciare l'assenza di policy a fare il lavoro —
-- vedi nota F-090 in AUDIT.md per il ragionamento tabella per tabella.

-- ──────────────────────────────────────────────────────────────
-- Helper: consulente proprietario del profilo cid (stesso pattern
-- SECURITY DEFINER di is_company_member, migrazione 002).
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION is_consultant_owner(cid uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.consultant_profiles
    WHERE id = cid AND user_id = auth.uid()
  );
$$;

-- Helper: la riga di booking_certificates eredita lo scoping della sua
-- prenotazione (company proprietaria O consulente assegnato).
CREATE OR REPLACE FUNCTION is_booking_accessible(p_booking_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.course_bookings cb
    WHERE cb.id = p_booking_id
      AND (is_company_member(cb.company_id) OR is_consultant_owner(cb.consultant_id))
  );
$$;

-- ──────────────────────────────────────────────────────────────
-- Gruppo A — dati di company, FOR ALL is_company_member(company_id)
-- ──────────────────────────────────────────────────────────────
CREATE POLICY "site_equipment_company_member" ON site_equipment FOR ALL
  USING (is_company_member(company_id)) WITH CHECK (is_company_member(company_id));

CREATE POLICY "site_subcontractors_company_member" ON site_subcontractors FOR ALL
  USING (is_company_member(company_id)) WITH CHECK (is_company_member(company_id));

CREATE POLICY "site_note_reminders_company_member" ON site_note_reminders FOR ALL
  USING (is_company_member(company_id)) WITH CHECK (is_company_member(company_id));

CREATE POLICY "site_suspension_days_company_member" ON site_suspension_days FOR ALL
  USING (is_company_member(company_id)) WITH CHECK (is_company_member(company_id));

CREATE POLICY "expiry_notifications_company_member" ON expiry_notifications FOR ALL
  USING (is_company_member(company_id)) WITH CHECK (is_company_member(company_id));

-- ──────────────────────────────────────────────────────────────
-- Gruppo B — log generati dal sistema, sola lettura
-- ──────────────────────────────────────────────────────────────
CREATE POLICY "site_weather_alert_sent_select" ON site_weather_alert_sent FOR SELECT
  USING (is_company_member(company_id));

CREATE POLICY "coordinator_verifications_select" ON coordinator_verifications FOR SELECT
  USING (is_company_member(company_id));

CREATE POLICY "studio_durc_alert_log_select" ON studio_durc_alert_log FOR SELECT
  USING (is_studio_member(studio_id));

-- ──────────────────────────────────────────────────────────────
-- Gruppo C — marketplace consulenza
-- ──────────────────────────────────────────────────────────────
CREATE POLICY "consultant_profiles_select" ON consultant_profiles FOR SELECT
  USING (is_active OR user_id = auth.uid());
CREATE POLICY "consultant_profiles_insert" ON consultant_profiles FOR INSERT
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "consultant_profiles_update" ON consultant_profiles FOR UPDATE
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "consultant_profiles_delete" ON consultant_profiles FOR DELETE
  USING (user_id = auth.uid());

CREATE POLICY "consultant_payouts_select" ON consultant_payouts FOR SELECT
  USING (is_consultant_owner(consultant_id));

CREATE POLICY "consultant_clients_all" ON consultant_clients FOR ALL
  USING (is_consultant_owner(consultant_id) OR is_company_member(company_id))
  WITH CHECK (is_consultant_owner(consultant_id) OR is_company_member(company_id));

CREATE POLICY "course_quote_requests_all" ON course_quote_requests FOR ALL
  USING (is_company_member(company_id) OR is_consultant_owner(consultant_id))
  WITH CHECK (is_company_member(company_id) OR is_consultant_owner(consultant_id));

CREATE POLICY "course_bookings_all" ON course_bookings FOR ALL
  USING (is_company_member(company_id) OR is_consultant_owner(consultant_id))
  WITH CHECK (is_company_member(company_id) OR is_consultant_owner(consultant_id));

CREATE POLICY "booking_certificates_all" ON booking_certificates FOR ALL
  USING (is_booking_accessible(booking_id)) WITH CHECK (is_booking_accessible(booking_id));

CREATE POLICY "course_reviews_select" ON course_reviews FOR SELECT
  USING (is_public OR is_company_member(company_id));
CREATE POLICY "course_reviews_write" ON course_reviews FOR ALL
  USING (is_company_member(company_id)) WITH CHECK (is_company_member(company_id));

CREATE POLICY "provider_reviews_all" ON provider_reviews FOR ALL
  USING (is_company_member(company_id)) WITH CHECK (is_company_member(company_id));

-- ──────────────────────────────────────────────────────────────
-- Gruppo D — catalogo, lettura pubblica per utenti autenticati
-- ──────────────────────────────────────────────────────────────
CREATE POLICY "course_types_select" ON course_types FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "marketplace_courses_select" ON marketplace_courses FOR SELECT
  TO authenticated USING (is_active AND NOT is_draft);

CREATE POLICY "course_sessions_select" ON course_sessions FOR SELECT
  TO authenticated USING (
    EXISTS (
      SELECT 1 FROM marketplace_courses mc
      WHERE mc.id = course_sessions.course_id AND mc.is_active AND NOT mc.is_draft
    )
  );

CREATE POLICY "training_providers_select" ON training_providers FOR SELECT
  TO authenticated USING (is_active);

-- ──────────────────────────────────────────────────────────────
-- Gruppo E — nessun client deve mai raggiungerle: deny-all esplicito.
-- service_role bypassa RLS per definizione (lib/supabase.js) quindi il
-- backend continua a funzionare invariato; questa policy blocca solo
-- authenticated/anon, formalizzando una decisione già dichiarata nei
-- commenti delle migrazioni 159/162 ma mai scritta come policy reale.
-- ──────────────────────────────────────────────────────────────
CREATE POLICY "_migrations_no_client_access" ON _migrations FOR ALL
  TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY "app_migrations_no_client_access" ON app_migrations FOR ALL
  TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY "ai_spend_alerts_no_client_access" ON ai_spend_alerts FOR ALL
  TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY "document_extra_homes_no_client_access" ON document_extra_homes FOR ALL
  TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY "document_sync_failures_no_client_access" ON document_sync_failures FOR ALL
  TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY "coordinator_profiles_no_client_access" ON coordinator_profiles FOR ALL
  TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY "coordinator_pro_sessions_no_client_access" ON coordinator_pro_sessions FOR ALL
  TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY "telegram_coordinator_link_codes_no_client_access" ON telegram_coordinator_link_codes FOR ALL
  TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY "telegram_coordinator_links_no_client_access" ON telegram_coordinator_links FOR ALL
  TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY "training_provider_sessions_no_client_access" ON training_provider_sessions FOR ALL
  TO authenticated, anon USING (false) WITH CHECK (false);
CREATE POLICY "attendance_no_client_access" ON attendance FOR ALL
  TO authenticated, anon USING (false) WITH CHECK (false);
