-- F-423 (AUDIT.md del frontend): le fatture dei fornitori, confrontate con le bolle.
-- Separata da company_expenses (Economia, senza righe e spenta per le imprese nuove):
-- qui servono i materiali, con quantità e prezzi, per dire «ti fanno pagare 5 sacchi in più».
CREATE TABLE IF NOT EXISTS fatture (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fornitore       text,
  fornitore_piva  text,
  numero          text,
  data            date,
  totale          numeric,
  righe           jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- [{descrizione, quantita, unita, prezzo, importo}]
  bolle_citate    text[]      NOT NULL DEFAULT '{}',          -- i numeri dei DDT scritti nella fattura
  esito           text        NOT NULL DEFAULT 'senza_bolle' CHECK (esito IN ('torna', 'non_torna', 'senza_bolle')),
  confronto       jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- il risultato di lib/confronto.js al salvataggio
  accettata_at    timestamptz,                                -- «Va bene così»
  file_path       text,
  mime_type       text,
  content_hash    text,
  origine         text        NOT NULL DEFAULT 'carica' CHECK (origine IN ('carica', 'email')),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fatture_azienda ON fatture (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fatture_hash ON fatture (company_id, content_hash);
ALTER TABLE fatture ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS bolle_fattura ON bolle (fattura_id);
