-- 258 — F-393 (AUDIT.md del frontend): il foglio del mese parte al commercialista
-- con un tocco («Un tocco tuo, PDF ed Excel», decisione del titolare del 21/10).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS consulente_nome text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS consulente_email text;

-- Ogni invio resta scritto: «Mandato il … a …» e Da fare smette di ricordarlo.
CREATE TABLE IF NOT EXISTS ore_invii (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month          text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  sent_at        timestamptz NOT NULL DEFAULT now(),
  sent_to        text NOT NULL,
  sent_by        uuid,
  lavoratori     integer,
  domande_aperte integer,
  email_id       text
);
CREATE INDEX IF NOT EXISTS ore_invii_company_month ON ore_invii (company_id, month);
-- Solo il backend (service role) legge e scrive: nessuna policy per gli utenti.
ALTER TABLE ore_invii ENABLE ROW LEVEL SECURITY;
