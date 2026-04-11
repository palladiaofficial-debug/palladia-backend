-- Migration 040: fasi di lavoro del cantiere
-- Derivate automaticamente dalle categorie del capitolato, editabili manualmente

CREATE TABLE IF NOT EXISTS site_phases (
  id                      uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id              uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id                 uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  nome                    text        NOT NULL,
  stato                   text        NOT NULL DEFAULT 'non_iniziata'
    CHECK (stato IN ('non_iniziata', 'in_corso', 'completata', 'sospesa')),
  progresso_percentuale   integer     NOT NULL DEFAULT 0
    CHECK (progresso_percentuale BETWEEN 0 AND 100),
  data_inizio_prevista    date,
  data_fine_prevista      date,
  data_inizio_reale       date,
  data_fine_reale         date,
  importo_contratto       numeric,    -- somma importi voci capitolato di questa fase
  importo_maturato        numeric     NOT NULL DEFAULT 0,  -- valore lavori eseguiti
  note                    text,
  sort_order              integer     NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE site_phases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_members_site_phases"
  ON site_phases FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

CREATE INDEX IF NOT EXISTS idx_site_phases_site
  ON site_phases (site_id);

CREATE INDEX IF NOT EXISTS idx_site_phases_site_stato
  ON site_phases (site_id, stato);

-- Lavoratori assegnati a una fase
CREATE TABLE IF NOT EXISTS site_phase_workers (
  id          uuid      NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  uuid      NOT NULL,
  site_id     uuid      NOT NULL,
  phase_id    uuid      NOT NULL REFERENCES site_phases(id) ON DELETE CASCADE,
  worker_id   uuid      NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  UNIQUE (phase_id, worker_id)
);

ALTER TABLE site_phase_workers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_members_site_phase_workers"
  ON site_phase_workers FOR ALL
  USING  (is_company_member(company_id))
  WITH CHECK (is_company_member(company_id));

CREATE INDEX IF NOT EXISTS idx_site_phase_workers_phase
  ON site_phase_workers (phase_id);

CREATE INDEX IF NOT EXISTS idx_site_phase_workers_worker
  ON site_phase_workers (worker_id);
