-- 261 — F-399 (AUDIT.md del frontend): «Carica le buste del mese». Il PDF unico
-- del commercialista resta qui finché il titolare non ha controllato come l'ho
-- diviso; alla conferma diventa una busta per operaio (payslips) e il file
-- caricato si cancella. Solo il backend (service role) legge e scrive.
CREATE TABLE IF NOT EXISTS buste_caricamenti (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  file_path      text NOT NULL,
  nome_file      text,
  pagine         integer NOT NULL,
  analisi        jsonb NOT NULL,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  confermato_at  timestamptz,
  esito          jsonb
);
CREATE INDEX IF NOT EXISTS buste_caricamenti_company ON buste_caricamenti (company_id, created_at DESC);
ALTER TABLE buste_caricamenti ENABLE ROW LEVEL SECURITY;
