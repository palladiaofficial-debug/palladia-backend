-- 193_coordinator_notes_photo_gps.sql
-- Sopralluogo fotografico per il verbale del Coordinatore della Sicurezza.
--
-- Confronto diretto con un verbale reale prodotto da un concorrente (myAEDES):
-- documentava le foto/note del sopralluogo fisico, ma con un difetto grave —
-- un'unica persona (il geometra) risultava "presente" e firmataria per conto
-- di tutte le parti (direzione lavori, impresa affidataria, subappaltatrice),
-- nessuna controfirma reale. Il verbale Palladia già evita quel problema per
-- costruzione: ogni nota è vincolata a site_coordinator_invites.invite_id,
-- risolto lato server dal token/sessione autenticata, mai dal client — un
-- coordinatore non può scrivere una nota "per conto" di un'altra parte.
--
-- Quello che mancava era la parte che myAEDES faceva bene: documentare
-- fotograficamente cosa si è visto sul posto, con data/ora e — se il
-- dispositivo la fornisce — la posizione GPS dello scatto. Additivo: nessuna
-- tabella nuova, solo colonne nullable sulla tabella esistente. Una nota
-- "photo_path IS NULL" resta una nota di testo come oggi; una con
-- "photo_path IS NOT NULL" alimenta la nuova sezione "Sopralluogo
-- fotografico" del verbale invece di "Note del Coordinatore".

ALTER TABLE site_coordinator_notes
  ADD COLUMN IF NOT EXISTS photo_path text,
  ADD COLUMN IF NOT EXISTS gps_lat    numeric(9,6),
  ADD COLUMN IF NOT EXISTS gps_lng    numeric(9,6);

COMMENT ON COLUMN site_coordinator_notes.photo_path IS
  'Path nel bucket site-documents (prefisso {company_id}/coordinator/{site_id}/{invite_id}/). NULL per le note di solo testo, invariate.';
COMMENT ON COLUMN site_coordinator_notes.gps_lat IS
  'Latitudine dello scatto, se il dispositivo del coordinatore l''ha fornita al momento dell''upload. Mai obbligatoria.';
COMMENT ON COLUMN site_coordinator_notes.gps_lng IS
  'Longitudine dello scatto — vedi gps_lat.';
