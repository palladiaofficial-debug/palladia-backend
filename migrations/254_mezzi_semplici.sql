-- 254 — F-375 (AUDIT.md del frontend): Mezzi «alla perfezione e nella massima semplicità».
-- Disegno approvato il 18/10: https://claude.ai/artifact/BABpBew9VmrM1SyacVt3CR (pagina «Mezzi e imprese»).
--
-- 1. Dal libretto: data di prima immatricolazione e massa complessiva, per
--    calcolare la revisione nel codice (lib/mezziRevisione.js). La colonna
--    `anno_immatricolazione` (testo) resta com'è per chi la usa già.
-- 2. Promemoria in più su un mezzo: bollo, tagliando, cronotachigrafo,
--    verifica periodica (gru, piattaforme), altro. Assicurazione e revisione
--    restano le colonne di `equipment` (le leggono cron, documenti, Ladia).
-- Solo il backend (service role) legge e scrive: RLS accesa, nessuna policy.

ALTER TABLE equipment ADD COLUMN IF NOT EXISTS data_immatricolazione date;
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS massa_kg integer CHECK (massa_kg IS NULL OR massa_kg > 0);

CREATE TABLE IF NOT EXISTS equipment_promemoria (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  equipment_id  uuid        NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  tipo          text        NOT NULL CHECK (tipo IN ('bollo', 'tagliando', 'cronotachigrafo', 'verifica', 'altro')),
  testo         text        CHECK (testo IS NULL OR char_length(btrim(testo)) BETWEEN 1 AND 80),
  scadenza      date        NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (tipo <> 'altro' OR testo IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS equipment_promemoria_mezzo ON equipment_promemoria (equipment_id);
CREATE INDEX IF NOT EXISTS equipment_promemoria_scadenza ON equipment_promemoria (scadenza);
ALTER TABLE equipment_promemoria ENABLE ROW LEVEL SECURITY;
