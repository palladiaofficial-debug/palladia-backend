-- Migration 055 — Recensioni corsi (provider + consulenti)

CREATE TABLE IF NOT EXISTS course_reviews (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID        NOT NULL UNIQUE REFERENCES course_bookings(id) ON DELETE CASCADE,
  course_id     UUID        NOT NULL REFERENCES marketplace_courses(id),
  company_id    UUID        NOT NULL REFERENCES companies(id),
  consultant_id UUID        REFERENCES consultant_profiles(id),
  provider_id   UUID        REFERENCES training_providers(id),
  rating        INTEGER     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT,
  is_public     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_course_reviews_course   ON course_reviews (course_id);
CREATE INDEX IF NOT EXISTS idx_course_reviews_consultant ON course_reviews (consultant_id) WHERE consultant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_course_reviews_provider ON course_reviews (provider_id) WHERE provider_id IS NOT NULL;
