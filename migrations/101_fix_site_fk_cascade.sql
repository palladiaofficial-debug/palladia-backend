-- Migration 101: Aggiunge ON DELETE CASCADE alle FK verso sites mancanti.
-- Senza CASCADE, la DELETE su sites fallisce con FK violation.

-- site_computo_voci
ALTER TABLE site_computo_voci DROP CONSTRAINT IF EXISTS site_computo_voci_site_id_fkey;
ALTER TABLE site_computo_voci
  ADD CONSTRAINT site_computo_voci_site_id_fkey
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE;

-- worker_certificates (site_id nullable — SET NULL è più appropriato)
ALTER TABLE worker_certificates DROP CONSTRAINT IF EXISTS worker_certificates_site_id_fkey;
ALTER TABLE worker_certificates
  ADD CONSTRAINT worker_certificates_site_id_fkey
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;

-- course_bookings (site_id nullable — SET NULL è più appropriato)
ALTER TABLE course_bookings DROP CONSTRAINT IF EXISTS course_bookings_site_id_fkey;
ALTER TABLE course_bookings
  ADD CONSTRAINT course_bookings_site_id_fkey
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
