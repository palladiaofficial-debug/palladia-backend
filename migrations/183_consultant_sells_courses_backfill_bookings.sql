-- 183_consultant_sells_courses_backfill_bookings.sql
-- F-103 follow-up: il backfill di 182 copriva solo consultant_profiles con
-- almeno un corso in marketplace_courses, non chi ha una prenotazione
-- (course_bookings) storica su un corso nel frattempo cancellato/rimosso.
-- Trovato in verifica indipendente post-deploy (nessun cliente reale
-- coinvolto: l'unico caso reale era una fixture sintetica dei test di
-- isolamento cross-tenant, mai loggata), ma la logica va comunque corretta.

UPDATE consultant_profiles
SET sells_courses = true
WHERE user_id IN (SELECT DISTINCT consultant_id FROM course_bookings WHERE consultant_id IS NOT NULL);
