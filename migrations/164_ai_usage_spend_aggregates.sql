-- ================================================================
-- Migration 164 — SUM lato database per la spesa AI (F-057, AUDIT.md)
--
-- Problema:
--   lib/ladiaUsageLog.js::getMonthlyAiSpend/getTodayAiSpend leggevano
--   TUTTE le righe di ladia_usage_log nel periodo e sommavano lato
--   Node — ma il client Supabase/PostgREST applica un limite di
--   default di 1000 righe per query, mai reso esplicito nel codice.
--   Trovato dal vivo: la company TEST-LadiaEvals ha 1783 righe questo
--   mese (fixture pesante delle suite di valutazione) — la query
--   restituiva silenziosamente solo le prime 1000, sottostimando la
--   spesa reale e quindi anche il verdetto di checkAiBudget (lo
--   stesso gate che blocca/permette Ladia in chat). Nessuna company
--   REALE (non di test) supera oggi le 900 righe/mese, ma è lo stesso
--   identico bug che protegge — o meno — il budget fair-use dei
--   clienti paganti man mano che l'uso cresce: esattamente il
--   controllo costi che deve essere "perfetto e infallibile".
--
-- Soluzione:
--   Due funzioni SQL che sommano lato database (nessun limite di
--   righe trasferite, un solo valore di ritorno) invece di scaricare
--   le righe e sommarle in Node.
--
-- Idempotente — CREATE OR REPLACE.
-- ================================================================

CREATE OR REPLACE FUNCTION ai_usage_monthly_spend(p_company_id uuid, p_since timestamptz)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(estimated_cost_usd), 0)
  FROM ladia_usage_log
  WHERE company_id = p_company_id
    AND created_at >= p_since;
$$;

CREATE OR REPLACE FUNCTION ai_usage_daily_spend(p_since timestamptz)
RETURNS TABLE(total numeric, external numeric)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(SUM(estimated_cost_usd), 0) AS total,
    COALESCE(SUM(estimated_cost_usd) FILTER (WHERE is_internal = false), 0) AS external
  FROM ladia_usage_log
  WHERE created_at >= p_since;
$$;
