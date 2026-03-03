-- ================================================================
-- Migration 002 — Multi-tenant security + Badge schema finale
-- Eseguire in Supabase → SQL Editor → Run
--
-- PREREQUISITO: Migration 001 deve essere già eseguita.
-- ATTENZIONE: Drop + recreate delle tabelle della 001.
--   Assumiamo tabelle vuote (ambiente dev). Se ci sono dati,
--   eseguire prima un backup manuale.
-- ================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────
-- 1. COMPANIES
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ──────────────────────────────────────────────────────────────
-- 2. COMPANY_USERS — membership user <-> company
-- user_id = auth.users.id (uuid, no FK diretto allo schema auth)
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_users (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL,
  role       text        NOT NULL DEFAULT 'tech'
                         CHECK (role IN ('owner','admin','tech','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_users_unique UNIQUE (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cu_user    ON company_users (user_id);
CREATE INDEX IF NOT EXISTS idx_cu_company ON company_users (company_id);

-- ──────────────────────────────────────────────────────────────
-- 3. SITES — aggiungi colonne company_id + geofence
-- (tabella preesistente — ALTER TABLE, non DROP)
-- ──────────────────────────────────────────────────────────────
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS company_id        uuid REFERENCES companies (id),
  ADD COLUMN IF NOT EXISTS latitude          double precision,
  ADD COLUMN IF NOT EXISTS longitude         double precision,
  ADD COLUMN IF NOT EXISTS geofence_radius_m int  NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS pin_code          text;

CREATE INDEX IF NOT EXISTS idx_sites_company ON sites (company_id);

-- ──────────────────────────────────────────────────────────────
-- 4. RICREA TABELLE DI MIGRAZIONE 001
--    (schema incompatibile: company_id TEXT→UUID, nuovi campi)
--    AZIONE: drop CASCADE (rimuove anche i vincoli)
-- ──────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS presence_logs      CASCADE;
DROP TABLE IF EXISTS worksite_workers   CASCADE;
DROP TABLE IF EXISTS badges             CASCADE;
DROP TABLE IF EXISTS workers            CASCADE;

-- Workers
CREATE TABLE workers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies (id),
  full_name   text        NOT NULL,
  fiscal_code text        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT  workers_company_fiscal_unique UNIQUE (company_id, fiscal_code)
);
CREATE INDEX idx_workers_company ON workers (company_id);
CREATE INDEX idx_workers_fiscal  ON workers (fiscal_code);

-- Worksite Workers
CREATE TABLE worksite_workers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies (id),
  site_id     uuid        NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  worker_id   uuid        NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  status      text        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','inactive')),
  start_date  date,
  end_date    date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT  worksite_workers_unique UNIQUE (site_id, worker_id)
);
CREATE INDEX idx_ww_site   ON worksite_workers (site_id);
CREATE INDEX idx_ww_worker ON worksite_workers (worker_id);

-- Badges (opzionale, base per badge fisici futuri)
CREATE TABLE badges (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL REFERENCES companies (id),
  worker_id    uuid        NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  badge_number text        NOT NULL UNIQUE,
  is_active    boolean     NOT NULL DEFAULT true,
  issued_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_badges_worker ON badges (worker_id);

-- ──────────────────────────────────────────────────────────────
-- 5. WORKER DEVICE SESSIONS
-- Il session_token non è mai salvato in chiaro: solo SHA-256 hash.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE worker_device_sessions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL REFERENCES companies (id),
  worker_id    uuid        NOT NULL REFERENCES workers (id) ON DELETE CASCADE,
  token_hash   text        NOT NULL UNIQUE,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + INTERVAL '60 days'),
  revoked_at   timestamptz
);
CREATE INDEX idx_sessions_worker ON worker_device_sessions (worker_id, expires_at);
CREATE INDEX idx_sessions_hash   ON worker_device_sessions (token_hash);

-- ──────────────────────────────────────────────────────────────
-- 6. PRESENCE LOGS — APPEND-ONLY
-- event_type determinato server-side: mai accettato dal client.
-- Nessuna policy UPDATE/DELETE → append-only garantito da RLS.
-- ──────────────────────────────────────────────────────────────
CREATE TABLE presence_logs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES companies (id),
  site_id          uuid        NOT NULL REFERENCES sites (id),
  worker_id        uuid        NOT NULL REFERENCES workers (id),
  event_type       text        NOT NULL CHECK (event_type IN ('ENTRY','EXIT')),
  timestamp_server timestamptz NOT NULL DEFAULT now(),
  latitude         double precision,
  longitude        double precision,
  distance_m       int,
  ip_address       text,
  user_agent       text,
  session_id       uuid        REFERENCES worker_device_sessions (id),
  method           text        NOT NULL DEFAULT 'personal_phone'
);
CREATE INDEX idx_presence_site_ts   ON presence_logs (site_id, timestamp_server DESC);
CREATE INDEX idx_presence_worker_ts ON presence_logs (worker_id, site_id, timestamp_server DESC);
CREATE INDEX idx_presence_company   ON presence_logs (company_id, timestamp_server DESC);

-- ──────────────────────────────────────────────────────────────
-- 7. RLS — Row Level Security
--
-- Il backend usa la SERVICE KEY (bypassa RLS).
-- RLS protegge accesso diretto da client con anon/user token.
--
-- Helper SECURITY DEFINER: evita ricorsione RLS su company_users.
-- ──────────────────────────────────────────────────────────────

-- Funzione helper: true se auth.uid() è membro della company cid
CREATE OR REPLACE FUNCTION is_company_member(cid uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.company_users
    WHERE  company_id = cid
    AND    user_id    = auth.uid()
  );
$$;

-- companies
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "companies_select" ON companies
  FOR SELECT USING (is_company_member(id));

-- company_users: SELECT su proprie righe + stessa company; INSERT/UPDATE/DELETE via backend
ALTER TABLE company_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cu_select" ON company_users
  FOR SELECT USING (user_id = auth.uid() OR is_company_member(company_id));

-- sites
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sites_select" ON sites
  FOR SELECT USING (company_id IS NULL OR is_company_member(company_id));
CREATE POLICY "sites_insert" ON sites
  FOR INSERT WITH CHECK (is_company_member(company_id));
CREATE POLICY "sites_update" ON sites
  FOR UPDATE USING (is_company_member(company_id));

-- workers
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workers_select" ON workers
  FOR SELECT USING (is_company_member(company_id));
CREATE POLICY "workers_insert" ON workers
  FOR INSERT WITH CHECK (is_company_member(company_id));
CREATE POLICY "workers_update" ON workers
  FOR UPDATE USING (is_company_member(company_id));

-- worksite_workers
ALTER TABLE worksite_workers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ww_select" ON worksite_workers
  FOR SELECT USING (is_company_member(company_id));
CREATE POLICY "ww_insert" ON worksite_workers
  FOR INSERT WITH CHECK (is_company_member(company_id));
CREATE POLICY "ww_update" ON worksite_workers
  FOR UPDATE USING (is_company_member(company_id));

-- worker_device_sessions
ALTER TABLE worker_device_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sessions_select" ON worker_device_sessions
  FOR SELECT USING (is_company_member(company_id));

-- presence_logs — APPEND-ONLY: SELECT + INSERT only, no UPDATE/DELETE policy
ALTER TABLE presence_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "presence_select" ON presence_logs
  FOR SELECT USING (is_company_member(company_id));
CREATE POLICY "presence_insert" ON presence_logs
  FOR INSERT WITH CHECK (is_company_member(company_id));
-- NESSUNA policy UPDATE o DELETE → bloccate da RLS per default

COMMIT;

-- ================================================================
-- POST-MIGRAZIONE: inserisci la prima company + aggiungi il tuo
-- user come owner. Sostituisci i valori con i tuoi UUID reali.
--
-- INSERT INTO companies (id, name) VALUES
--   ('00000000-0000-0000-0000-000000000001', 'La Mia Azienda');
--
-- INSERT INTO company_users (company_id, user_id, role) VALUES
--   ('00000000-0000-0000-0000-000000000001', auth.uid(), 'owner');
-- ================================================================
