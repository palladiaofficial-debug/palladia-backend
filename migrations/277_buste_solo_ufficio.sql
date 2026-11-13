-- 277 — F-494 (AUDIT.md del frontend, 13/11/2026): le buste paga le vede solo
-- l'ufficio, cioè titolare (owner) e amministratori (admin). Prima bastava
-- essere un account dell'impresa: verificato dal vivo che un «tech» leggeva la
-- tabella payslips col suo JWT. Stessa regola del backend (lib/busteRiservate.js).

-- 1. true se auth.uid() è titolare o amministratore della company cid
CREATE OR REPLACE FUNCTION is_company_manager(cid uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_users
    WHERE company_id = cid AND user_id = auth.uid() AND role IN ('owner', 'admin')
  );
$$;

-- 2. payslips: via tutte le regole che ci sono (099 e 100 ne avevano due,
--    entrambe «basta essere membro»), una sola per l'ufficio
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'payslips' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.payslips', p.policyname);
  END LOOP;
END $$;
ALTER TABLE payslips ENABLE ROW LEVEL SECURITY;
CREATE POLICY payslips_solo_ufficio ON payslips
  FOR ALL
  USING (is_company_manager(company_id))
  WITH CHECK (is_company_manager(company_id));

-- 3. documents (tabella unificata, migr. 150): le righe delle buste solo all'ufficio,
--    il resto come prima a tutti i membri
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'documents' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.documents', p.policyname);
  END LOOP;
END $$;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY documents_company_member ON documents
  FOR ALL
  USING (
    is_company_member(company_id)
    AND ((source_table IS DISTINCT FROM 'payslips' AND category IS DISTINCT FROM 'busta_paga') OR is_company_manager(company_id))
  )
  WITH CHECK (
    is_company_member(company_id)
    AND ((source_table IS DISTINCT FROM 'payslips' AND category IS DISTINCT FROM 'busta_paga') OR is_company_manager(company_id))
  );

-- 4. I prospetti e riepiloghi del commercialista (le paghe di tutti) non vanno
--    più in Documenti › Impresa, che vedono anche tecnici e coordinatori: restano
--    col loro caricamento, nella scheda Buste paga (solo ufficio).
ALTER TABLE buste_caricamenti ADD COLUMN IF NOT EXISTS riepilogo_path text;
ALTER TABLE buste_caricamenti ADD COLUMN IF NOT EXISTS riepilogo_pagine integer;
