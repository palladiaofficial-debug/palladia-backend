-- Migration 128: log token/costo per ogni chiamata AI di Ladia.
-- Prima non esisteva nessuna visibilità sulla spesa reale: il credito Anthropic
-- si esauriva senza che nulla nel prodotto spiegasse da dove venisse. Questa
-- tabella registra ogni chiamata (per conversazione, per company) con token
-- reali e costo stimato in USD, calcolato con i prezzi ufficiali dei modelli.

CREATE TABLE IF NOT EXISTS ladia_usage_log (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id                   uuid,
  conversation_id           uuid        REFERENCES chat_conversations(id) ON DELETE SET NULL,
  model                     text        NOT NULL,
  call_site                 text        NOT NULL,   -- es. 'chat_stream', 'generate_pos_risks', 'auto_title', 'report_json'
  input_tokens              integer     NOT NULL DEFAULT 0,
  output_tokens             integer     NOT NULL DEFAULT 0,
  cache_creation_tokens     integer     NOT NULL DEFAULT 0,
  cache_read_tokens         integer     NOT NULL DEFAULT 0,
  estimated_cost_usd        numeric(10,6) NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ladia_usage_log_company_created ON ladia_usage_log(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ladia_usage_log_conversation     ON ladia_usage_log(conversation_id);

ALTER TABLE ladia_usage_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ladia_usage_log_company ON ladia_usage_log;
CREATE POLICY ladia_usage_log_company ON ladia_usage_log
  FOR ALL USING (is_company_member(company_id));
