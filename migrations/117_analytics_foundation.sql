-- Migration 117: analytics foundation — company_daily_stats
--
-- Aggregato giornaliero per company. Popolato dal dailyStatsCron alle 00:15.
-- Consente a Ladia di rispondere a domande di trend ("quante presenze questa settimana?",
-- "stiamo aumentando l'utilizzo rispetto al mese scorso?") senza query pesanti
-- sulla tabella presence_logs da milioni di righe.
-- Base per benchmark futuri: "aziende simili hanno X presenze/giorno in media".

CREATE TABLE IF NOT EXISTS company_daily_stats (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date            date        NOT NULL,
  -- Badge digitale
  badge_entries   integer     NOT NULL DEFAULT 0,
  badge_exits     integer     NOT NULL DEFAULT 0,
  active_sites    integer     NOT NULL DEFAULT 0,  -- cantieri con almeno 1 scan
  active_workers  integer     NOT NULL DEFAULT 0,  -- lavoratori unici presenti
  -- Ladia AI
  ladia_queries   integer     NOT NULL DEFAULT 0,
  -- Metadata
  computed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, date)
);

CREATE INDEX IF NOT EXISTS idx_company_daily_stats_company_date
  ON company_daily_stats (company_id, date DESC);

ALTER TABLE company_daily_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_daily_stats_select_own" ON company_daily_stats
  FOR SELECT TO authenticated
  USING (is_company_member(company_id));

-- ── Funzione di calcolo ──────────────────────────────────────────────────────
-- Chiamata dal cron nightly per ogni company.
-- UPSERT: sicura da richiamare più volte (idempotente).

CREATE OR REPLACE FUNCTION compute_company_daily_stats(p_company_id uuid, p_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entries   integer := 0;
  v_exits     integer := 0;
  v_sites     integer := 0;
  v_workers   integer := 0;
  v_queries   integer := 0;
  v_day_start timestamptz;
  v_day_end   timestamptz;
BEGIN
  -- Intervallo in UTC per il giorno solare italiano (CET/CEST gestito da AT TIME ZONE)
  v_day_start := (p_date::text || ' 00:00:00')::timestamp AT TIME ZONE 'Europe/Rome';
  v_day_end   := (p_date::text || ' 00:00:00')::timestamp AT TIME ZONE 'Europe/Rome' + interval '1 day';

  -- Badge stats del giorno
  SELECT
    COUNT(*) FILTER (WHERE event_type = 'ENTRY'),
    COUNT(*) FILTER (WHERE event_type = 'EXIT'),
    COUNT(DISTINCT site_id),
    COUNT(DISTINCT worker_id)
  INTO v_entries, v_exits, v_sites, v_workers
  FROM presence_logs
  WHERE company_id  = p_company_id
    AND timestamp_server >= v_day_start
    AND timestamp_server <  v_day_end;

  -- Query Ladia del giorno (solo messaggi 'user' = query reali dell'operatore)
  SELECT COUNT(*)
  INTO v_queries
  FROM chat_messages cm
  JOIN chat_conversations cc ON cc.id = cm.conversation_id
  WHERE cc.company_id = p_company_id
    AND cm.role = 'user'
    AND cm.created_at >= v_day_start
    AND cm.created_at <  v_day_end;

  INSERT INTO company_daily_stats (
    company_id, date,
    badge_entries, badge_exits, active_sites, active_workers,
    ladia_queries, computed_at
  ) VALUES (
    p_company_id, p_date,
    v_entries, v_exits, v_sites, v_workers,
    v_queries, now()
  )
  ON CONFLICT (company_id, date) DO UPDATE SET
    badge_entries  = EXCLUDED.badge_entries,
    badge_exits    = EXCLUDED.badge_exits,
    active_sites   = EXCLUDED.active_sites,
    active_workers = EXCLUDED.active_workers,
    ladia_queries  = EXCLUDED.ladia_queries,
    computed_at    = now();
END;
$$;

-- Backfill degli ultimi 90 giorni per tutte le company esistenti
-- (commenta questo blocco se il DB è grande e preferisci farlo manualmente)
DO $$
DECLARE
  r         record;
  d         date;
  today     date := current_date;
BEGIN
  FOR r IN SELECT id FROM companies LOOP
    FOR d IN SELECT generate_series(today - 89, today - 1, '1 day'::interval)::date LOOP
      BEGIN
        PERFORM compute_company_daily_stats(r.id, d);
      EXCEPTION WHEN OTHERS THEN
        -- ignora errori nel backfill
        NULL;
      END;
    END LOOP;
  END LOOP;
END;
$$;
