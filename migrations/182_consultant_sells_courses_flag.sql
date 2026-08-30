-- 182_consultant_sells_courses_flag.sql
-- F-103 (AUDIT.md, repo frontend): il Portale Consulente RSPP mostrava sempre
-- l'intera area vendita corsi (I miei corsi/Prenotazioni/Preventivi/Pagamenti)
-- anche a chi ha scelto "Consulente RSPP" solo per seguire la conformità di
-- più imprese clienti, senza alcun interesse a vendere formazione. Aggiunge
-- un flag esplicito, opt-in: la sidebar mostra quelle voci solo se true (o se
-- il consulente ha già corsi/prenotazioni reali). Default false per i nuovi
-- profili; backfill true solo per chi ha già almeno un corso creato, cosi'
-- nessun consulente gia' attivo sulla vendita corsi perde l'accesso.

ALTER TABLE consultant_profiles ADD COLUMN IF NOT EXISTS sells_courses boolean NOT NULL DEFAULT false;

-- consultant_id nelle tabelle correlate (marketplace_courses, consultant_clients,
-- course_bookings, ...) e' sempre l'auth user_id (vedi middleware/verifyConsultant.js,
-- req.consultantId = user.id), non consultant_profiles.id — join su user_id.
UPDATE consultant_profiles
SET sells_courses = true
WHERE user_id IN (SELECT DISTINCT consultant_id FROM marketplace_courses WHERE consultant_id IS NOT NULL);
