-- Migration 195: pausa pranzo configurabile per azienda, con override per cantiere
--
-- F-152 (AUDIT.md, frontend): un turno unico ENTRY->EXIT senza timbratura
-- intermedia di pausa pranzo veniva conteggiato per intero nelle ore lavorate
-- (es. 07:37->17:01 = 9h24m), perché l'unico modo per escludere la pausa dal
-- calcolo era che il lavoratore timbrasse davvero un'uscita e un rientro.
-- Aggiunge una detrazione forfettaria configurabile per azienda (con override
-- opzionale per cantiere), applicata SOLO quando il turno del giorno è
-- un'unica coppia ENTRY/EXIT continua sopra soglia — se ci sono 2+ coppie il
-- lavoratore ha già timbrato una pausa reale, già esclusa naturalmente dalla
-- somma (vedi lib/presencePairing.js), e non va detratta una seconda volta.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS lunch_break_minutes         INTEGER      NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS lunch_break_threshold_hours NUMERIC(4,2) NOT NULL DEFAULT 6;

-- NULL su sites = eredita il valore azienda (nessun override impostato)
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS lunch_break_minutes         INTEGER      DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lunch_break_threshold_hours NUMERIC(4,2) DEFAULT NULL;

COMMENT ON COLUMN companies.lunch_break_minutes         IS 'Minuti di pausa pranzo detratti automaticamente dalle ore lavorate quando il turno del giorno è una singola timbratura continua sopra soglia (default 30)';
COMMENT ON COLUMN companies.lunch_break_threshold_hours IS 'Ore di turno continuo oltre le quali si applica la detrazione pausa pranzo (default 6)';
COMMENT ON COLUMN sites.lunch_break_minutes             IS 'Override per cantiere di companies.lunch_break_minutes — NULL eredita il valore azienda';
COMMENT ON COLUMN sites.lunch_break_threshold_hours     IS 'Override per cantiere di companies.lunch_break_threshold_hours — NULL eredita il valore azienda';
