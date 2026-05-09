-- Migration 058 — Slug SEO per marketplace_courses

CREATE EXTENSION IF NOT EXISTS unaccent;

ALTER TABLE marketplace_courses
  ADD COLUMN IF NOT EXISTS slug TEXT UNIQUE;

-- Funzione per generare slug da titolo + città
CREATE OR REPLACE FUNCTION generate_course_slug(title TEXT, city TEXT, id UUID)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  base TEXT;
  candidate TEXT;
  suffix INT := 0;
BEGIN
  base := lower(
    regexp_replace(
      regexp_replace(
        unaccent(coalesce(title, '') || '-' || coalesce(city, '')),
        '[^a-z0-9\s-]', '', 'g'
      ),
      '\s+', '-', 'g'
    )
  );
  base := regexp_replace(base, '-+', '-', 'g');
  base := trim(both '-' from base);
  base := left(base, 80);

  candidate := base;
  LOOP
    -- usa l'id UUID come fallback finale (non può collidere)
    IF candidate = '' THEN candidate := id::text; END IF;
    IF NOT EXISTS (SELECT 1 FROM marketplace_courses WHERE slug = candidate AND id != id) THEN
      RETURN candidate;
    END IF;
    suffix := suffix + 1;
    candidate := base || '-' || suffix;
  END LOOP;
END;
$$;

-- Backfill slug su righe esistenti
UPDATE marketplace_courses
SET slug = generate_course_slug(title, location_city, id)
WHERE slug IS NULL;

-- Trigger auto-slug su INSERT/UPDATE se slug è NULL
CREATE OR REPLACE FUNCTION marketplace_courses_auto_slug()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := generate_course_slug(NEW.title, NEW.location_city, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS marketplace_courses_slug_trigger ON marketplace_courses;
CREATE TRIGGER marketplace_courses_slug_trigger
  BEFORE INSERT OR UPDATE OF title, location_city ON marketplace_courses
  FOR EACH ROW EXECUTE FUNCTION marketplace_courses_auto_slug();
