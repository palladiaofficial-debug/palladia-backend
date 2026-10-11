-- 247 — F-335 (AUDIT.md del frontend): due causali che mancavano per un
-- foglio presenze completo (Libro unico del lavoro: ogni assenza ha la sua
-- causale): l'infortunio come giornata intera (finora solo come motivo
-- d'uscita) e l'assenza ingiustificata, che il titolare sceglie quando un
-- giorno senza timbrature non ha nessuna giustificazione.
ALTER TABLE worker_absences DROP CONSTRAINT IF EXISTS worker_absences_tipo_check;
ALTER TABLE worker_absences ADD CONSTRAINT worker_absences_tipo_check
  CHECK (tipo IN ('ferie', 'permesso', 'malattia', 'altro', 'maltempo', 'infortunio', 'ingiustificata'));
