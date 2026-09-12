-- ================================================================
-- Migration 206 — F-179 (AUDIT.md): il bucket worker-photos era pubblico
-- E le sue regole storage.objects erano ancora più larghe del flag
-- "public" da solo: SELECT concesso al ruolo public senza alcun controllo,
-- INSERT/UPDATE concessi a QUALUNQUE utente autenticato di QUALUNQUE
-- azienda, senza verificare che il percorso (company_id/worker_id.ext)
-- appartenesse alla propria. Sostituite con regole scoperte per azienda,
-- stesso helper is_company_member già usato su sites/companies/ecc.
--
-- DA ESEGUIRE MANUALMENTE in Supabase → SQL Editor: la RPC exec_sql usata
-- per le altre migrazioni di questo repo non ha i permessi per alterare
-- storage.objects (di proprietà di supabase_storage_admin) — verificato dal
-- vivo, non un limite di questo script. Il flag "public" del bucket e il
-- backfill di workers.photo_url restano automatizzati in
-- scripts/run-migration-206.js.
-- ================================================================

DROP POLICY IF EXISTS "Public read worker photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload worker photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update worker photos" ON storage.objects;

-- Il percorso di ogni oggetto è sempre "<company_id>/<worker_id>.<ext>" —
-- (storage.foldername(name))[1] estrae il primo segmento (company_id).
CREATE POLICY worker_photos_select_company ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'worker-photos' AND is_company_member((storage.foldername(name))[1]::uuid));

CREATE POLICY worker_photos_insert_company ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'worker-photos' AND is_company_member((storage.foldername(name))[1]::uuid));

CREATE POLICY worker_photos_update_company ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'worker-photos' AND is_company_member((storage.foldername(name))[1]::uuid));
