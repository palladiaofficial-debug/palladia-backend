-- 200_lunch_break_override.sql
-- F-169 (AUDIT.md): la detrazione automatica pausa pranzo (F-152) deduce
-- sempre i minuti configurati quando un giorno è un'unica coppia
-- ENTRY/EXIT continua sopra soglia — assumendo che la pausa sia stata
-- fatta ma non timbrata. Non distingue questo caso da un lavoratore che
-- ha davvero saltato la pausa e lavorato senza sosta: in quel caso la
-- detrazione lo penalizza di minuti realmente lavorati.
--
-- Richiesto esplicitamente dal titolare: un modo per l'admin di segnalare,
-- da Presenze & Report, "niente pausa oggi" per un lavoratore/giorno — in
-- quel caso Palladia non detrae nulla e paga la presenza reale.

CREATE TABLE IF NOT EXISTS presence_lunch_overrides (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worker_id    uuid        NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  work_date    date        NOT NULL,
  note         text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (worker_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_presence_lunch_overrides_company_date
  ON presence_lunch_overrides(company_id, work_date);

ALTER TABLE presence_lunch_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY presence_lunch_overrides_company_member ON presence_lunch_overrides
  FOR ALL USING (is_company_member(company_id))
  WITH CHECK    (is_company_member(company_id));
