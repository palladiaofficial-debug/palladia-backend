-- 246 — F-335 (AUDIT.md del frontend): orario di lavoro per contare le ore.
-- Le buste paga si fanno sull'orario, non sui minuti timbrati (lib/oreContrattuali.js).
-- Tre livelli, il più specifico vince: lavoratore (orario personale) → cantiere
-- → azienda. Tutto facoltativo: NULL = vale il livello sotto, e per l'azienda
-- il predefinito 8:00–17:00 con pausa 12–13, finché il titolare non lo conferma
-- (orario_confermato_at). Le timbrature non cambiano.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS orario_inizio          time,
  ADD COLUMN IF NOT EXISTS orario_fine            time,
  ADD COLUMN IF NOT EXISTS pausa_inizio           time,
  ADD COLUMN IF NOT EXISTS pausa_fine             time,
  ADD COLUMN IF NOT EXISTS orario_tolleranza_min  smallint CHECK (orario_tolleranza_min BETWEEN 0 AND 30),
  ADD COLUMN IF NOT EXISTS straord_soglia_min     smallint CHECK (straord_soglia_min BETWEEN 0 AND 120),
  ADD COLUMN IF NOT EXISTS straord_blocco_min     smallint CHECK (straord_blocco_min BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS orario_confermato_at   timestamptz;

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS orario_inizio  time,
  ADD COLUMN IF NOT EXISTS orario_fine    time,
  ADD COLUMN IF NOT EXISTS pausa_inizio   time,
  ADD COLUMN IF NOT EXISTS pausa_fine     time;

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS orario_inizio  time,
  ADD COLUMN IF NOT EXISTS orario_fine    time,
  ADD COLUMN IF NOT EXISTS pausa_inizio   time,
  ADD COLUMN IF NOT EXISTS pausa_fine     time,
  -- "No, per lui vale l'orario dell'azienda": la domanda sull'orario personale non torna
  ADD COLUMN IF NOT EXISTS orario_personale_rifiutato boolean NOT NULL DEFAULT false,
  -- Prima di questa data non era in forza (o timbrava su carta): quei giorni non sono "da giustificare"
  ADD COLUMN IF NOT EXISTS ore_da         date,
  ADD COLUMN IF NOT EXISTS ore_da_motivo  text CHECK (ore_da_motivo IN ('assunto', 'carta'));

DO $$ BEGIN
  ALTER TABLE companies ADD CONSTRAINT companies_orario_valido CHECK (orario_inizio IS NULL OR orario_fine IS NULL OR orario_fine > orario_inizio);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE sites ADD CONSTRAINT sites_orario_valido CHECK (orario_inizio IS NULL OR orario_fine IS NULL OR orario_fine > orario_inizio);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE workers ADD CONSTRAINT workers_orario_valido CHECK (orario_inizio IS NULL OR orario_fine IS NULL OR orario_fine > orario_inizio);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
