-- Migration 028: Prezziari regionali + prezzi fornitori azienda
-- Abilita Ladia a fare analisi prezzi, computi estimativi, ricerche per lavorazione.

-- ── Prezzario regionale (dati pubblici, non per-company) ─────────────────────
CREATE TABLE IF NOT EXISTS prezzario_voci (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  regione        text          NOT NULL,            -- 'liguria', 'lombardia', ecc.
  anno           integer       NOT NULL,
  codice         text,                              -- codice voce prezzario (es. D.01.010)
  categoria      text          NOT NULL,
  sottocategoria text,
  descrizione    text          NOT NULL,
  um             text          NOT NULL,            -- unità di misura
  prezzo         numeric(12,4) NOT NULL,            -- prezzo unitario €
  costo_mat      numeric(12,4),                     -- quota materiali €
  costo_mdo      numeric(12,4),                     -- quota manodopera €
  costo_noli     numeric(12,4),                     -- quota noli €
  note           text,
  -- colonna generata per full-text search in italiano
  descrizione_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('italian', descrizione)
  ) STORED,
  created_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prezzario_regione_anno  ON prezzario_voci(regione, anno);
CREATE INDEX IF NOT EXISTS idx_prezzario_fts            ON prezzario_voci USING gin(descrizione_tsv);
CREATE INDEX IF NOT EXISTS idx_prezzario_categoria      ON prezzario_voci(categoria);
CREATE INDEX IF NOT EXISTS idx_prezzario_codice         ON prezzario_voci(codice) WHERE codice IS NOT NULL;

-- ── Prezzi fornitori per azienda (personalizzati, per-company) ────────────────
CREATE TABLE IF NOT EXISTS company_prezzi (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  descrizione    text          NOT NULL,
  fornitore      text,
  um             text          NOT NULL,
  prezzo         numeric(12,4) NOT NULL,
  categoria      text,
  valid_from     date,
  valid_to       date,
  note           text,
  descrizione_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('italian', descrizione)
  ) STORED,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_prezzi_company ON company_prezzi(company_id);
CREATE INDEX IF NOT EXISTS idx_company_prezzi_fts     ON company_prezzi USING gin(descrizione_tsv);
