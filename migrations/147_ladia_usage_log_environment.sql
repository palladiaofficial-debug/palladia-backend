-- Migration 147: separa spesa AI interna (founder/master company, cioè le
-- sessioni Claude Code, gli audit, i selftest) da spesa AI di clienti reali.
-- ladia_usage_log mescolava le due nella stessa company (il proprio account di
-- test), rendendo impossibile sapere quanto costa davvero un cliente attivo —
-- il numero che decide se il pricing regge (vedi ladia_cost_sustainability_check).

ALTER TABLE ladia_usage_log
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_ladia_usage_log_internal_created
  ON ladia_usage_log(is_internal, created_at DESC);
