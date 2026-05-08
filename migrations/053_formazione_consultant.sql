-- ─── 053_formazione_consultant.sql ──────────────────────────────────────────
-- Estende il modulo Formazione con:
--   · consultant_profiles     — profilo professionale RSPP/consulente
--   · consultant_clients      — relazione consulente ↔ imprese clienti
--   · booking_certificates    — attestati emessi post-corso (consulente → worker)
--   · consultant_payouts      — tracciamento pagamenti consulenti
-- Altera:
--   · marketplace_courses     — supporto corsi pubblicati da consulenti
--   · course_bookings         — supporto prenotazione multi-worker + consulente
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Profilo professionale consulente ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS consultant_profiles (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid        NOT NULL UNIQUE,
  company_name             text,
  vat_number               text,
  registration_number      text,
  operative_regions        text[]      DEFAULT '{}',
  bio                      text,
  photo_url                text,
  accreditation_bodies     jsonb       DEFAULT '[]',
  years_experience         integer,
  total_workers_trained    integer     DEFAULT 0,
  total_client_companies   integer     DEFAULT 0,
  avg_rating               numeric(3,2) DEFAULT 0,
  total_reviews            integer     DEFAULT 0,
  is_active                boolean     DEFAULT true,
  onboarding_completed     boolean     DEFAULT false,
  created_at               timestamptz DEFAULT now()
);

-- ── Relazione consulente ↔ imprese clienti ────────────────────────────────────

CREATE TABLE IF NOT EXISTS consultant_clients (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  consultant_id    uuid        NOT NULL,
  company_id       uuid        REFERENCES companies(id) ON DELETE CASCADE,
  status           text        CHECK (status IN ('pending','active','suspended')) DEFAULT 'pending',
  invited_at       timestamptz DEFAULT now(),
  accepted_at      timestamptz,
  invite_token     text        UNIQUE,
  invite_email     text,
  can_view_workers      boolean DEFAULT true,
  can_view_certificates boolean DEFAULT true,
  can_view_sites        boolean DEFAULT true,
  UNIQUE(consultant_id, company_id)
);

-- ── Attestati emessi post-corso ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS booking_certificates (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid        REFERENCES course_bookings(id),
  worker_id      uuid        REFERENCES workers(id),
  certificate_id uuid        REFERENCES worker_certificates(id),
  uploaded_by    uuid,
  uploaded_at    timestamptz DEFAULT now()
);

-- ── Payouts consulente ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS consultant_payouts (
  id                  uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  consultant_id       uuid    NOT NULL,
  period_start        date    NOT NULL,
  period_end          date    NOT NULL,
  total_bookings      integer NOT NULL,
  gross_amount_cents  integer NOT NULL,
  commission_cents    integer NOT NULL,
  net_amount_cents    integer NOT NULL,
  status              text    CHECK (status IN ('pending','processing','paid')) DEFAULT 'pending',
  stripe_transfer_id  text,
  paid_at             timestamptz,
  created_at          timestamptz DEFAULT now()
);

-- ── Alter marketplace_courses — supporto consulenti ──────────────────────────

ALTER TABLE marketplace_courses
  ADD COLUMN IF NOT EXISTS consultant_id            uuid,
  ADD COLUMN IF NOT EXISTS is_draft                 boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS issuing_body_name        text,
  ADD COLUMN IF NOT EXISTS issuing_body_accreditation text,
  ADD COLUMN IF NOT EXISTS total_bookings           integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_revenue_cents      integer DEFAULT 0;

-- ── Alter course_bookings — multi-worker + consulente ────────────────────────

ALTER TABLE course_bookings
  ADD COLUMN IF NOT EXISTS consultant_id         uuid,
  ADD COLUMN IF NOT EXISTS workers_data          jsonb,
  ADD COLUMN IF NOT EXISTS participants_count    integer,
  ADD COLUMN IF NOT EXISTS unit_price_cents      integer,
  ADD COLUMN IF NOT EXISTS commission_rate       numeric(4,2),
  ADD COLUMN IF NOT EXISTS consultant_payout_cents integer,
  ADD COLUMN IF NOT EXISTS confirmed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_consultant_profiles_user    ON consultant_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_consultant_clients_cons     ON consultant_clients(consultant_id);
CREATE INDEX IF NOT EXISTS idx_consultant_clients_company  ON consultant_clients(company_id);
CREATE INDEX IF NOT EXISTS idx_consultant_clients_token    ON consultant_clients(invite_token) WHERE invite_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_certs_booking       ON booking_certificates(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_certs_worker        ON booking_certificates(worker_id);
CREATE INDEX IF NOT EXISTS idx_payouts_consultant          ON consultant_payouts(consultant_id);
CREATE INDEX IF NOT EXISTS idx_mc_consultant               ON marketplace_courses(consultant_id) WHERE consultant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_consultant         ON course_bookings(consultant_id) WHERE consultant_id IS NOT NULL;
