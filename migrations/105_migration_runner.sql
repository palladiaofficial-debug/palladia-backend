-- Tabella per tracciare le migrazioni applicate + RPC per eseguire SQL arbitrario
-- Usate da scripts/migrate.js

CREATE TABLE IF NOT EXISTS _migrations (
  id         serial      PRIMARY KEY,
  file_name  text        NOT NULL UNIQUE,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- RPC per eseguire SQL arbitrario (usata dal migration runner)
CREATE OR REPLACE FUNCTION exec_sql(sql_text text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  EXECUTE sql_text;
END;
$$;

-- RPC helper per il runner (check se la tabella esiste)
CREATE OR REPLACE FUNCTION ensure_migrations_table()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  CREATE TABLE IF NOT EXISTS _migrations (
    id         serial      PRIMARY KEY,
    file_name  text        NOT NULL UNIQUE,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
END;
$$;
