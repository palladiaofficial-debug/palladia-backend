-- Migration 196: default pausa pranzo azienda 30min -> 60min
--
-- Richiesta esplicita dell'utente il giorno dopo il lancio di migrations/195
-- ("di default metti sempre 1 ora di pausa pranzo"): 30 minuti era una scelta
-- arbitraria fatta senza input reale. Il default a livello di colonna cambia
-- per le nuove company; le company esistenti vengono aggiornate SOLO se sono
-- ancora al valore di default mai personalizzato (30) — non tocca chi ha già
-- scelto esplicitamente un valore diverso (i pochi record già a 45min in
-- produzione, tutti fixture di test create durante lo sviluppo di F-152,
-- restano invariati).
ALTER TABLE companies
  ALTER COLUMN lunch_break_minutes SET DEFAULT 60;

UPDATE companies
  SET lunch_break_minutes = 60
  WHERE lunch_break_minutes = 30;

COMMENT ON COLUMN companies.lunch_break_minutes IS 'Minuti di pausa pranzo detratti automaticamente dalle ore lavorate quando il turno del giorno è una singola timbratura continua sopra soglia (default 60)';
