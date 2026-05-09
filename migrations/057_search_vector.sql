-- Migration 057 — Full-text search su marketplace_courses (pg_tsvector)

ALTER TABLE marketplace_courses
  ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION marketplace_courses_search_vector_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('italian', coalesce(NEW.title,            '')), 'A') ||
    setweight(to_tsvector('italian', coalesce(NEW.description,      '')), 'B') ||
    setweight(to_tsvector('italian', coalesce(NEW.location_city,    '')), 'C') ||
    setweight(to_tsvector('italian', coalesce(NEW.issuing_body_name,'')), 'C');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS marketplace_courses_search_vector_trigger ON marketplace_courses;
CREATE TRIGGER marketplace_courses_search_vector_trigger
  BEFORE INSERT OR UPDATE ON marketplace_courses
  FOR EACH ROW EXECUTE FUNCTION marketplace_courses_search_vector_update();

-- Backfill righe esistenti
UPDATE marketplace_courses SET search_vector =
  setweight(to_tsvector('italian', coalesce(title,            '')), 'A') ||
  setweight(to_tsvector('italian', coalesce(description,      '')), 'B') ||
  setweight(to_tsvector('italian', coalesce(location_city,    '')), 'C') ||
  setweight(to_tsvector('italian', coalesce(issuing_body_name,'')), 'C');

CREATE INDEX IF NOT EXISTS idx_marketplace_courses_search
  ON marketplace_courses USING gin(search_vector);
