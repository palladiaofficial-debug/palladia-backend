-- 279 — F-498 (AUDIT.md del frontend): documenti delle imprese chiesti giusti.
-- 1. Il tipo d'impresa decide cosa le si chiede (tabella «Cosa chiediamo a chi»):
--    con_operai | da_solo | familiare. NULL = non si sa ancora: si chiede come a
--    chi ha operai (come prima). tipo_da: chi l'ha detto (visura letta, titolare).
--    L'impresa con sede all'estero arriverà dopo il sì del consulente.
-- 2. «Lo faccio entro…»: la promessa dell'impresa per un documento che non ha.
--    entro NULL = «non lo so ancora». chiave = «<tipo>:<cantiere o vuoto>».
-- 3. Il link si chiude da solo dopo 60 giorni senza uso: usato_at.
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS tipo_impresa text
  CHECK (tipo_impresa IS NULL OR tipo_impresa IN ('con_operai', 'da_solo', 'familiare'));
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS tipo_da text
  CHECK (tipo_da IS NULL OR tipo_da IN ('visura', 'titolare'));
UPDATE subcontractors SET tipo_impresa = 'da_solo', tipo_da = 'titolare' WHERE autonomo = true AND tipo_impresa IS NULL;

ALTER TABLE sub_link ADD COLUMN IF NOT EXISTS usato_at timestamptz;

CREATE TABLE IF NOT EXISTS sub_doc_promesse (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subcontractor_id  uuid        NOT NULL REFERENCES subcontractors(id) ON DELETE CASCADE,
  chiave            text        NOT NULL CHECK (char_length(chiave) BETWEEN 3 AND 80),
  entro             date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subcontractor_id, chiave)
);
ALTER TABLE sub_doc_promesse ENABLE ROW LEVEL SECURITY;
