-- 255 — F-376 (AUDIT.md del frontend): Imprese in subappalto «alla perfezione e nella massima semplicità».
-- Disegno approvato il 18/10: https://claude.ai/artifact/BABpBew9VmrM1SyacVt3CR (pagina «Mezzi e imprese», I1–I7).
--
-- 1. I documenti che l'impresa manda dal suo link (senza registrarsi) stanno in
--    subcontractor_documents come gli altri, con: il cantiere (il POS è per
--    cantiere), da chi arrivano, l'esito del controllo di Palladia (nome,
--    partita IVA, date, firma) e quando il titolare li ha visti.
--    `ai_validity_ok` (già sincronizzata in `documents`) è false quando l'esito
--    è «non va»: un documento sbagliato non conta come presente.
-- 2. Il link dell'impresa: uno per impresa, sempre lo stesso (l'impresa lo
--    tiene). Nel DB niente token: il token è HMAC(segreto, id) e si ricalcola;
--    `token_hash` serve a ritrovare il link da una richiesta.
-- 3. Gli operai dell'impresa (sub_workers, migr. 249) si possono aggiungere
--    anche dal link, con la loro visita medica e il corso di sicurezza.
-- 4. Un'impresa aggiunta col solo telefono è «da completare»: i suoi dati li
--    scrive lei dal link.
-- Solo il backend (service role) legge e scrive le tabelle nuove: RLS accesa, nessuna policy.

ALTER TABLE subcontractor_documents ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES sites(id) ON DELETE SET NULL;
ALTER TABLE subcontractor_documents ADD COLUMN IF NOT EXISTS dall_impresa boolean NOT NULL DEFAULT false;
ALTER TABLE subcontractor_documents ADD COLUMN IF NOT EXISTS esito text CHECK (esito IS NULL OR esito IN ('va_bene', 'non_va'));
ALTER TABLE subcontractor_documents ADD COLUMN IF NOT EXISTS esito_motivo text;
ALTER TABLE subcontractor_documents ADD COLUMN IF NOT EXISTS visto_at timestamptz;
CREATE INDEX IF NOT EXISTS subcontractor_documents_da_vedere
  ON subcontractor_documents (company_id, subcontractor_id) WHERE dall_impresa AND visto_at IS NULL;

ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS da_completare boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS sub_link (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subcontractor_id uuid        NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  token_hash       text        NOT NULL UNIQUE,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  inviato_at       timestamptz,
  aperto_at        timestamptz,
  revoked_at       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS sub_link_uno_per_impresa ON sub_link (subcontractor_id) WHERE revoked_at IS NULL;
ALTER TABLE sub_link ENABLE ROW LEVEL SECURITY;

ALTER TABLE sub_workers DROP CONSTRAINT IF EXISTS sub_workers_added_via_check;
ALTER TABLE sub_workers ADD CONSTRAINT sub_workers_added_via_check CHECK (added_via IN ('qr', 'squadra', 'ufficio', 'link'));

CREATE TABLE IF NOT EXISTS sub_worker_documenti (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sub_worker_id  uuid        NOT NULL REFERENCES sub_workers(id) ON DELETE CASCADE,
  tipo           text        NOT NULL CHECK (tipo IN ('idoneita', 'formazione')),
  scadenza       date,
  file_path      text        NOT NULL,
  mime_type      text,
  dall_impresa   boolean     NOT NULL DEFAULT false,
  esito          text        CHECK (esito IS NULL OR esito IN ('va_bene', 'non_va')),
  esito_motivo   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sub_worker_documenti_operaio ON sub_worker_documenti (sub_worker_id, tipo, created_at DESC);
ALTER TABLE sub_worker_documenti ENABLE ROW LEVEL SECURITY;
