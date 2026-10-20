-- 256 — F-386 (AUDIT.md del frontend): la sospensione disciplinare come
-- causale d'assenza («Carlos è stato sospeso, metti la funzione», il titolare,
-- 19/10). Prima finiva come «Assente» (ingiustificata) o «Altro»: il consulente
-- del lavoro non la distingueva nel foglio del mese.
ALTER TABLE worker_absences DROP CONSTRAINT IF EXISTS worker_absences_tipo_check;
ALTER TABLE worker_absences ADD CONSTRAINT worker_absences_tipo_check
  CHECK (tipo IN ('ferie', 'permesso', 'malattia', 'altro', 'maltempo', 'infortunio', 'ingiustificata', 'sospensione'));
