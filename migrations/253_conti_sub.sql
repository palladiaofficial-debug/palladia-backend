-- 253 — F-360 (AUDIT.md del frontend): Conti dei sub.
-- Il tecnico carica il foglio del subappaltatore (Excel, PDF, foto); Palladia lo
-- legge, lo confronta con gli ingressi (sub_presenze, migr. 249), con i prezzi
-- dei conti già approvati e con le quantità del contratto, e il tecnico approva.
-- Mockup approvato il 17/10: https://claude.ai/artifact/MmTtR3Vd7P9j29qyhzjBug
--
-- Niente contabilità: niente ritenute, computo, capitolato, margini.
-- Solo il backend (service role) legge e scrive: RLS accesa, nessuna policy
-- (stesso schema di sub_presenze e lavagna_righe).
-- I fogli caricati vanno nel bucket privato `conti-sub` (Excel compreso):
-- node scripts/setup_bucket_conti_sub.js

-- Un conto = un foglio di un sub, per un cantiere e un mese.
CREATE TABLE IF NOT EXISTS sub_conti (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subcontractor_id  uuid          REFERENCES subcontractors(id) ON DELETE SET NULL,
  impresa_nome      text          NOT NULL CHECK (char_length(btrim(impresa_nome)) >= 2),
  impresa_chiave    text          NOT NULL,
  site_id           uuid          REFERENCES sites(id) ON DELETE SET NULL,
  cantiere_testo    text,
  mese              date          NOT NULL CHECK (extract(day FROM mese) = 1),
  stato             text          NOT NULL DEFAULT 'da_controllare' CHECK (stato IN ('da_controllare', 'approvato')),
  -- ore: tariffa letta dal foglio, imparata dai conti approvati, decisa dal tecnico
  tariffa_foglio    numeric(10,2),
  tariffa_nota      numeric(10,2),
  tariffa           numeric(10,2),
  tariffa_decisione text          CHECK (tariffa_decisione IS NULL OR tariffa_decisione IN ('foglio', 'proposta')),
  totale_scritto    numeric(12,2),
  totale_approvato  numeric(12,2),
  file_path         text,
  file_nome         text,
  senza_ingressi    boolean       NOT NULL DEFAULT false,
  approvato_da      uuid,
  approvato_da_nome text,
  approvato_at      timestamptz,
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sub_conti_azienda ON sub_conti (company_id, stato, mese DESC);
CREATE INDEX IF NOT EXISTS sub_conti_impresa ON sub_conti (company_id, impresa_chiave);

-- Le righe del foglio: ore (persona, giorno) o lavori a misura (voce × quantità × prezzo).
CREATE TABLE IF NOT EXISTS sub_conti_righe (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  conto_id         uuid          NOT NULL REFERENCES sub_conti(id) ON DELETE CASCADE,
  company_id       uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ordine           integer       NOT NULL DEFAULT 0,
  tipo             text          NOT NULL CHECK (tipo IN ('ore', 'misura')),
  -- ore
  persona          text,
  giorno           date,
  ore_foglio       numeric(8,2),
  ore_ingressi     numeric(8,2),
  -- misura
  voce             text,
  voce_chiave      text,
  unita            text,
  quantita_foglio  numeric(12,2),
  prezzo_foglio    numeric(12,2),
  importo_scritto  numeric(12,2),
  prezzo_noto      numeric(12,2),
  contratto        numeric(12,2),
  gia_approvato    numeric(12,2),
  -- il controllo
  problema         text          CHECK (problema IS NULL OR problema IN ('non_entrato', 'ore_diverse', 'prezzo_diverso', 'oltre_contratto', 'prezzo_mancante')),
  proposta         numeric(12,2),
  decisione        text          CHECK (decisione IS NULL OR decisione IN ('foglio', 'proposta')),
  valore           numeric(12,2),
  created_at       timestamptz   NOT NULL DEFAULT now(),
  CHECK ((tipo = 'ore' AND persona IS NOT NULL AND ore_foglio IS NOT NULL) OR (tipo = 'misura' AND voce IS NOT NULL AND quantita_foglio IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS sub_conti_righe_conto ON sub_conti_righe (conto_id, ordine);

-- Prezzi imparati dai conti approvati (e quantità del contratto, se il tecnico le scrive).
CREATE TABLE IF NOT EXISTS sub_prezzi (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  impresa_chiave   text          NOT NULL,
  site_id          uuid          REFERENCES sites(id) ON DELETE CASCADE,
  voce_chiave      text          NOT NULL,   -- '__ore' = tariffa oraria
  voce             text          NOT NULL,
  unita            text,
  prezzo           numeric(12,2),
  contratto        numeric(12,2),
  da_conto_id      uuid          REFERENCES sub_conti(id) ON DELETE SET NULL,
  updated_at       timestamptz   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sub_prezzi_unico
  ON sub_prezzi (company_id, impresa_chiave, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid), voce_chiave);

ALTER TABLE sub_conti       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_conti_righe ENABLE ROW LEVEL SECURITY;
ALTER TABLE sub_prezzi      ENABLE ROW LEVEL SECURITY;
