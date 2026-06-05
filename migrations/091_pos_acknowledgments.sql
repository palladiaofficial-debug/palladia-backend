-- Migration 091: firma digitale POS da parte dei lavoratori
-- I lavoratori confermano la lettura durante la timbratura badge

CREATE TABLE IF NOT EXISTS pos_acknowledgments (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pos_id          uuid        NOT NULL REFERENCES pos_documents(id) ON DELETE CASCADE,
  worker_id       uuid        NOT NULL REFERENCES workers(id)       ON DELETE CASCADE,
  company_id      uuid        NOT NULL,
  site_id         uuid        NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  ip              text,
  ua              text,
  UNIQUE (pos_id, worker_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_ack_pos    ON pos_acknowledgments(pos_id);
CREATE INDEX IF NOT EXISTS idx_pos_ack_site   ON pos_acknowledgments(site_id, acknowledged_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_ack_worker ON pos_acknowledgments(worker_id, pos_id);
