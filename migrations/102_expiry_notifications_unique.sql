-- ─── 102_expiry_notifications_unique.sql ─────────────────────────────────────
-- Fix race condition: two cron instances can both SELECT "not found" and both
-- INSERT a duplicate notification.
--
-- Solution: atomic upsert_expiry_notification() RPC + unique constraint.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Deduplicate existing rows: keep only the most recent per (certificate_id, notification_type)
DELETE FROM expiry_notifications a
USING expiry_notifications b
WHERE a.certificate_id    = b.certificate_id
  AND a.notification_type = b.notification_type
  AND a.sent_at           < b.sent_at;

-- 2. Unique constraint so the DB enforces one row per (certificate_id, notification_type)
CREATE UNIQUE INDEX IF NOT EXISTS idx_expiry_notifs_cert_type
  ON expiry_notifications (certificate_id, notification_type);

-- 3. Atomic upsert: insert only if the existing row is older than 7 days (or absent).
--    Returns the row if a NEW notification was created, NULL if skipped.
CREATE OR REPLACE FUNCTION upsert_expiry_notification(
  p_certificate_id    uuid,
  p_worker_id         uuid,
  p_company_id        uuid,
  p_notification_type text
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO expiry_notifications (certificate_id, worker_id, company_id, notification_type, sent_at)
  VALUES (p_certificate_id, p_worker_id, p_company_id, p_notification_type, now())
  ON CONFLICT (certificate_id, notification_type)
  DO UPDATE SET
    sent_at    = now(),
    worker_id  = EXCLUDED.worker_id,
    company_id = EXCLUDED.company_id,
    read_at    = NULL,
    action_taken = NULL
  WHERE expiry_notifications.sent_at < now() - interval '7 days'
  RETURNING id INTO v_id;

  RETURN v_id;  -- NULL means skipped (recent notification already exists)
END;
$$;
