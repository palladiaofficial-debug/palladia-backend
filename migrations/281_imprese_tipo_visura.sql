-- 281 — F-501 (AUDIT.md del frontend): il tipo d'impresa che dice la visura, sempre salvato,
-- anche quando il titolare ha già scelto: se non coincidono la scheda lo dice
-- («La visura dice: ha dipendenti»), perché una scelta sbagliata toglie documenti dovuti.
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS tipo_visura text
  CHECK (tipo_visura IS NULL OR tipo_visura IN ('con_operai', 'da_solo', 'familiare'));
