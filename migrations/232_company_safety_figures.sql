-- 232 — Figure della sicurezza ricordate per azienda (F-263)
-- "Ricorda queste figure per i prossimi POS": datore di lavoro, RSPP, RLS,
-- medico competente, preposto, addetti emergenze, direttore tecnico.
-- figures = { <chiave figura>: { nome, telefono, email, codiceFiscale } }
-- Letta e scritta solo dal backend (service role): RLS attivo, nessuna policy.
CREATE TABLE IF NOT EXISTS company_safety_figures (
  company_id  uuid        PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  figures     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE company_safety_figures ENABLE ROW LEVEL SECURITY;
