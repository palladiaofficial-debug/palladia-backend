-- Migration 199: soglia di ritardo ingresso configurabile, con detrazione forfettaria
--
-- Richiesto dall'utente il 2026-09-10: un ingresso oltre una soglia di
-- tolleranza rispetto all'orario di inizio turno previsto comporta una
-- detrazione forfettaria dalle ore lavorate di quel giorno — sempre annotata
-- nel resoconto (mai una detrazione silenziosa, stesso principio della pausa
-- pranzo automatica, migration 195).
--
-- A differenza della pausa pranzo (sempre attiva con un default), questa
-- regola parte SPENTA per ogni azienda: shift_start_time NULL = nessun
-- orario di inizio turno previsto configurato = nessuna detrazione possibile,
-- a prescindere da soglia/detrazione. Si attiva solo quando un'azienda
-- imposta esplicitamente un orario di inizio turno — un default "silenzioso"
-- rischierebbe di detrarre stipendio reale a chi non ha mai deciso di
-- attivare questa regola.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS shift_start_time             TIME    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS late_entry_threshold_minutes INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS late_entry_deduction_minutes INTEGER NOT NULL DEFAULT 30;

-- NULL su sites = eredita il valore azienda (nessun override impostato)
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS shift_start_time             TIME    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS late_entry_threshold_minutes INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS late_entry_deduction_minutes INTEGER DEFAULT NULL;

COMMENT ON COLUMN companies.shift_start_time             IS 'Orario di inizio turno previsto (default azienda) — NULL = regola ritardo disattivata, nessuna detrazione mai applicata';
COMMENT ON COLUMN companies.late_entry_threshold_minutes IS 'Minuti di tolleranza oltre shift_start_time prima di considerare un ingresso in ritardo (default 5)';
COMMENT ON COLUMN companies.late_entry_deduction_minutes IS 'Minuti detratti forfettariamente dalle ore lavorate del giorno quando l''ingresso è in ritardo oltre la soglia (default 30)';
COMMENT ON COLUMN sites.shift_start_time             IS 'Override per cantiere di companies.shift_start_time — NULL eredita il valore azienda (che a sua volta può essere NULL = regola disattivata)';
COMMENT ON COLUMN sites.late_entry_threshold_minutes IS 'Override per cantiere di companies.late_entry_threshold_minutes — NULL eredita il valore azienda';
COMMENT ON COLUMN sites.late_entry_deduction_minutes IS 'Override per cantiere di companies.late_entry_deduction_minutes — NULL eredita il valore azienda';
