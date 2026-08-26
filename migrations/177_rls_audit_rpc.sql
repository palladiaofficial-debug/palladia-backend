-- RPC di sola introspezione per l'audit di isolamento multi-tenant (BLOCCO 1).
-- Espone solo metadati (nome tabella, stato RLS, numero/nomi policy), MAI righe
-- di dati applicativi. Usata da scripts/selftest_cross_tenant_isolation.js per
-- verificare dal vivo, non a memoria, quali tabelle hanno RLS attivo senza
-- policy reali (deny-all silenzioso) — vedi feedback_verify_rls_live_not_grep.

CREATE OR REPLACE FUNCTION public.rls_audit()
RETURNS TABLE (
  table_name    text,
  rls_enabled   boolean,
  policy_count  bigint,
  policy_names  text[]
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    c.relname::text                                             AS table_name,
    c.relrowsecurity                                             AS rls_enabled,
    COUNT(p.polname)                                             AS policy_count,
    COALESCE(array_agg(p.polname) FILTER (WHERE p.polname IS NOT NULL), '{}') AS policy_names
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policy p ON p.polrelid = c.oid
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT LIKE 'pg_%'
  GROUP BY c.relname, c.relrowsecurity
  ORDER BY c.relname;
$$;

REVOKE ALL ON FUNCTION public.rls_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_audit() TO service_role;

-- Dettaglio di una singola policy (qual/with_check) per verificare che il filtro
-- sia davvero scoping-ato sul tenant e non un "true" travestito da controllo.
CREATE OR REPLACE FUNCTION public.rls_policy_detail(p_table text)
RETURNS TABLE (
  policy_name text,
  cmd         text,
  roles       text[],
  using_expr  text,
  check_expr  text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    p.polname::text,
    CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE '*' END,
    ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(p.polroles)),
    pg_get_expr(p.polqual, p.polrelid),
    pg_get_expr(p.polwithcheck, p.polrelid)
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE c.relname = p_table;
$$;

REVOKE ALL ON FUNCTION public.rls_policy_detail(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_policy_detail(text) TO service_role;
