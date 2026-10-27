-- 259 — F-396 (AUDIT.md del frontend): «non lavora più qui» con il giorno e il
-- motivo («serve la possibilità di poter mettere in sospensione o poter
-- licenziare un operaio», il titolare, 27/10). Prima c'era solo is_active=false,
-- senza data né motivo, e chi veniva disattivato non si ritrovava più.
-- La sospensione resta un'assenza (worker_absences, tipo 'sospensione', F-386).
ALTER TABLE workers ADD COLUMN IF NOT EXISTS cessato_il date;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS cessazione_motivo text;
ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_cessazione_motivo_check;
ALTER TABLE workers ADD CONSTRAINT workers_cessazione_motivo_check
  CHECK (cessazione_motivo IS NULL OR cessazione_motivo IN ('licenziamento', 'dimissioni', 'fine_contratto', 'altro'));
