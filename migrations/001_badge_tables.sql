-- ============================================================
-- Migration 001 — Badge Digitale: tabelle workers, presenze
-- Eseguire manualmente in Supabase > SQL Editor
-- ============================================================

-- 1. WORKERS — anagrafica lavoratori per azienda
-- company_id è TEXT per ora (nessuna tabella companies separata).
-- Unique su (company_id, fiscal_code): stesso CF non duplicabile nella stessa azienda.
CREATE TABLE IF NOT EXISTS workers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  text        NOT NULL,
  full_name   text        NOT NULL,
  fiscal_code text        NOT NULL,
  birth_date  date        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workers_company_fiscal_unique UNIQUE (company_id, fiscal_code)
);

CREATE INDEX IF NOT EXISTS idx_workers_company   ON workers (company_id);
CREATE INDEX IF NOT EXISTS idx_workers_fiscal    ON workers (fiscal_code);


-- 2. WORKSITE_WORKERS — lavoratori autorizzati su ogni cantiere
-- site_id referenzia la tabella esistente "sites".
-- (site_id, worker_id) è unique: un lavoratore ha una sola riga per cantiere.
CREATE TABLE IF NOT EXISTS worksite_workers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid        NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  worker_id   uuid        NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  is_active   boolean     NOT NULL DEFAULT true,
  start_date  date,
  end_date    date,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT worksite_workers_unique UNIQUE (site_id, worker_id)
);

CREATE INDEX IF NOT EXISTS idx_ww_site   ON worksite_workers (site_id);
CREATE INDEX IF NOT EXISTS idx_ww_worker ON worksite_workers (worker_id);


-- 3. BADGES — badge fisici emessi (opzionale MVP, base per futuro)
CREATE TABLE IF NOT EXISTS badges (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id    uuid        NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  badge_number text        NOT NULL UNIQUE,
  is_active    boolean     NOT NULL DEFAULT true,
  issued_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_badges_worker ON badges (worker_id);


-- 4. PRESENCE_LOGS — registro presenze append-only
-- Nessun UPDATE/DELETE consentito (applicare RLS se necessario).
-- source: 'selfscan' (QR self-scan MVP), 'manual' (inserimento admin futuro)
CREATE TABLE IF NOT EXISTS presence_logs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid        NOT NULL REFERENCES sites (id),
  worker_id   uuid        NOT NULL REFERENCES workers (id),
  action      text        NOT NULL CHECK (action IN ('entry', 'exit')),
  scanned_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  source      text        NOT NULL DEFAULT 'selfscan'
);

-- Indice principale per query giornaliere per cantiere
CREATE INDEX IF NOT EXISTS idx_presence_site_date   ON presence_logs (site_id, scanned_at);
CREATE INDEX IF NOT EXISTS idx_presence_worker_date ON presence_logs (worker_id, scanned_at);


-- ============================================================
-- RLS (opzionale — attivare quando si passa da service key a anon key)
-- ALTER TABLE workers        ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE worksite_workers ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE badges         ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE presence_logs  ENABLE ROW LEVEL SECURITY;
-- ============================================================
