-- Migration 123: chiude privilege-escalation su studio_users
--
-- La policy studio_users_insert (migration 063) permetteva a QUALSIASI utente
-- autenticato di inserire una riga in studio_users con studio_id arbitrario,
-- purché user_id = auth.uid() (clausola sempre vera su un self-insert).
-- SUPABASE_URL e SUPABASE_ANON_KEY sono esposti pubblicamente da GET /api/config,
-- quindi chiunque abbia un account Palladia poteva chiamare direttamente l'API
-- REST di Supabase e auto-assegnarsi il ruolo 'owner' su qualunque studio_id,
-- ottenendo accesso completo (via verifyStudioJwt) a tutte le imprese clienti
-- di quello studio.
--
-- L'unico inserimento legittimo (onboarding, upsert owner in routes/v1/studio.js)
-- passa dal backend con il client service-role (lib/supabase.js), che bypassa
-- comunque RLS: la clausola "OR user_id = auth.uid()" non serve a nessun flusso
-- reale e va rimossa.

DROP POLICY IF EXISTS studio_users_insert ON studio_users;

CREATE POLICY studio_users_insert ON studio_users FOR INSERT
  WITH CHECK (is_studio_member(studio_id));
