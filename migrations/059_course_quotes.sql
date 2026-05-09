-- Migration 059 — Pricing mode + preventivi per corsi in cantiere

ALTER TABLE marketplace_courses
  ADD COLUMN IF NOT EXISTS pricing_mode TEXT NOT NULL DEFAULT 'fixed'
    CHECK (pricing_mode IN ('fixed', 'quote'));

-- Nota: consultant_id usa auth.uid (= consultant_profiles.user_id) per coerenza
-- con marketplace_courses.consultant_id (stesso campo, stessa semantica)
CREATE TABLE IF NOT EXISTS course_quote_requests (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id        UUID        NOT NULL REFERENCES marketplace_courses(id),
  consultant_id    UUID        NOT NULL,   -- consultant_profiles.user_id = auth uid
  company_id       UUID        NOT NULL REFERENCES companies(id),
  participants_count INTEGER   NOT NULL CHECK (participants_count > 0 AND participants_count <= 200),
  site_address     TEXT        NOT NULL,
  preferred_dates  TEXT,
  notes            TEXT,
  status           TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'quoted', 'accepted', 'rejected', 'expired')),
  quoted_price_cents   INTEGER,
  quoted_message       TEXT,
  quoted_at            TIMESTAMPTZ,
  accepted_at          TIMESTAMPTZ,
  rejected_at          TIMESTAMPTZ,
  booking_id           UUID REFERENCES course_bookings(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX IF NOT EXISTS idx_quote_requests_consultant ON course_quote_requests (consultant_id);
CREATE INDEX IF NOT EXISTS idx_quote_requests_company    ON course_quote_requests (company_id);
CREATE INDEX IF NOT EXISTS idx_quote_requests_course     ON course_quote_requests (course_id);
CREATE INDEX IF NOT EXISTS idx_quote_requests_status     ON course_quote_requests (status);
