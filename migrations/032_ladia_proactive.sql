-- Migration 032: Ladia Proattiva
-- Tabella di deduplication per i messaggi proattivi di Ladia.
-- Previene lo spam: ogni trigger viene inviato al massimo una volta
-- per finestra di dedup (giorno / settimana / forever).

CREATE TABLE IF NOT EXISTS ladia_proactive_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id      UUID        REFERENCES sites(id) ON DELETE SET NULL,
  chat_id      TEXT        NOT NULL,
  trigger_type TEXT        NOT NULL,
  -- Chiave univoca per questo trigger: es. "rain_2026-04-03", "nc_<uuid>_2026-04-02"
  trigger_key  TEXT        NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indice per il check di dedup (molto frequente, < 10ms)
CREATE INDEX IF NOT EXISTS ladia_proactive_log_dedup_idx
  ON ladia_proactive_log (chat_id, trigger_type, trigger_key);

-- Indice per cleanup periodico dei log vecchi
CREATE INDEX IF NOT EXISTS ladia_proactive_log_sent_idx
  ON ladia_proactive_log (sent_at);
