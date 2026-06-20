-- ═══════════════════════════════════════════════════════════════════════════════
-- AUDIT FIX — 2026-06-20
-- Incollare intero in Supabase SQL Editor ed eseguire.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. Fix migrazione 045: UNIQUE constraint con syntax corretta ────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'course_types_name_key') THEN
    ALTER TABLE course_types ADD CONSTRAINT course_types_name_key UNIQUE (name);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_providers_email_key') THEN
    ALTER TABLE training_providers ADD CONSTRAINT training_providers_email_key UNIQUE (email);
  END IF;
END $$;


-- ── 2. Fix migrazione 014: storage policy con syntax corretta ───────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'equipment_docs_storage_select' AND tablename = 'objects') THEN
    CREATE POLICY "equipment_docs_storage_select"
      ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'equipment-docs');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'equipment_docs_storage_insert' AND tablename = 'objects') THEN
    CREATE POLICY "equipment_docs_storage_insert"
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'equipment-docs');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'equipment_docs_storage_delete' AND tablename = 'objects') THEN
    CREATE POLICY "equipment_docs_storage_delete"
      ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'equipment-docs');
  END IF;
END $$;


-- ── 3. RPC: increment_invite_uses (race condition invite link) ──────────────
CREATE OR REPLACE FUNCTION increment_invite_uses(p_invite_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE worker_invite_tokens
     SET uses_count = uses_count + 1
   WHERE id = p_invite_id;
$$;


-- ── 4. RPC: book_session_atomic (race condition overbooking corsi) ──────────
-- Incrementa booked_spots atomicamente, fallisce se posti insufficienti.
-- Ritorna i posti rimasti DOPO la prenotazione.
CREATE OR REPLACE FUNCTION book_session_atomic(
  p_session_id   uuid,
  p_num_workers  integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_spots_left integer;
BEGIN
  -- Lock sulla riga per serializzare le prenotazioni concorrenti
  UPDATE course_sessions
     SET booked_spots = booked_spots + p_num_workers
   WHERE id = p_session_id
     AND is_cancelled = false
     AND available_spots - booked_spots >= p_num_workers
  RETURNING available_spots - booked_spots INTO v_spots_left;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_ENOUGH_SPOTS';
  END IF;

  RETURN v_spots_left;
END;
$$;


-- ── 5. RPC: check_site_limit (race condition creazione cantieri) ────────────
-- Conta i cantieri billable e confronta col limite del piano.
-- Ritorna il conteggio attuale. Lancia eccezione se >= limite.
CREATE OR REPLACE FUNCTION check_site_limit(
  p_company_id  uuid,
  p_site_limit  integer  -- null = illimitato
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_site_limit IS NULL THEN
    RETURN 0;  -- nessun limite
  END IF;

  -- Advisory lock per company per serializzare creazioni concorrenti
  PERFORM pg_advisory_xact_lock(hashtext('site_limit_' || p_company_id::text));

  SELECT count(*)::integer INTO v_count
    FROM sites
   WHERE company_id = p_company_id
     AND status IN ('attivo', 'sospeso');

  IF v_count >= p_site_limit THEN
    RAISE EXCEPTION 'SITE_LIMIT_REACHED: % / %', v_count, p_site_limit;
  END IF;

  RETURN v_count;
END;
$$;


-- ── 6. RPC: next_sal_number (race condition numerazione SAL) ────────────────
-- Ritorna il prossimo sal_number per un cantiere, serializzando con advisory lock.
CREATE OR REPLACE FUNCTION next_sal_number(
  p_site_id     uuid,
  p_company_id  uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_next integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sal_' || p_site_id::text));

  SELECT COALESCE(MAX(sal_number), 0) + 1 INTO v_next
    FROM site_sal_history
   WHERE site_id    = p_site_id
     AND company_id = p_company_id;

  RETURN v_next;
END;
$$;


-- ── 7. Unique constraint su SAL per sicurezza extra ─────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_sal_history_site_number_uq') THEN
    ALTER TABLE site_sal_history
      ADD CONSTRAINT site_sal_history_site_number_uq
      UNIQUE (site_id, company_id, sal_number);
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE — 7 fix applicati.
-- ═══════════════════════════════════════════════════════════════════════════════
