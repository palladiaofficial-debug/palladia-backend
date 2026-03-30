-- ── Migration 024: Status cantiere esteso ────────────────────────────────────
-- Aggiunge 'ultimato' (lavori conclusi) ed 'eliminato' (soft-delete) ai valori
-- ammessi dalla colonna status della tabella sites.
--
-- 'ultimato'  → cantiere completato, non conta nel limite piano, non visibile in lista
--               principale ma i dati storici sono preservati
-- 'eliminato' → soft-delete: filtrato da tutte le query, dati storici (timbrature,
--               ecc.) preservati per vincolo append-only su presence_logs

ALTER TABLE sites
  DROP CONSTRAINT IF EXISTS sites_status_check;

ALTER TABLE sites
  ADD CONSTRAINT sites_status_check
  CHECK (status IN ('attivo', 'sospeso', 'ultimato', 'chiuso', 'eliminato'));
