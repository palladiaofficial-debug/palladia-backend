-- migration 115: RLS su chat_uploads — corregge critical security alert Supabase

ALTER TABLE chat_uploads ENABLE ROW LEVEL SECURITY;

-- Gli utenti autenticati vedono solo i propri upload (stessa company)
CREATE POLICY "chat_uploads_select_own"
  ON chat_uploads FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Solo il proprietario può inserire (protezione extra — il backend usa service_role)
CREATE POLICY "chat_uploads_insert_own"
  ON chat_uploads FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Solo il proprietario può cancellare upload non archiviati
CREATE POLICY "chat_uploads_delete_own"
  ON chat_uploads FOR DELETE
  TO authenticated
  USING (user_id = auth.uid() AND archived = false);

-- No UPDATE policy per utenti: il backend usa service_role per marcare archived=true
