-- Migration 118: tabella site_bookings, mai creata — il tool Ladia create_booking
-- ha sempre scritto su una tabella inesistente (errore DB ad ogni chiamata).

CREATE TABLE IF NOT EXISTS site_bookings (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id       uuid        NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
  title         text        NOT NULL,
  booking_date  date        NOT NULL,
  booking_time  time,
  category      text        NOT NULL DEFAULT 'consegna',
  supplier      text,
  notes         text,
  status        text        NOT NULL DEFAULT 'programmata',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_bookings_site
  ON site_bookings(site_id, booking_date);

CREATE INDEX IF NOT EXISTS idx_site_bookings_company
  ON site_bookings(company_id, booking_date);

ALTER TABLE site_bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY site_bookings_company_access ON site_bookings
  FOR ALL
  USING (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));
