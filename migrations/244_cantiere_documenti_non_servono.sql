-- 244 — F-321 (AUDIT.md del frontend): scheda cantiere senza cartelle.
-- PSC e notifica preliminare servono solo se in cantiere lavora più di
-- un'impresa; il POS non serve dove non è un cantiere (es. il magazzino):
-- il titolare può dire "Non serve" e il documento smette di
-- comparire tra quelli mancanti. Valori ammessi: 'pos', 'psc', 'notifica_asl'.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS documenti_non_servono text[] NOT NULL DEFAULT '{}';
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_documenti_non_servono_check;
ALTER TABLE sites ADD CONSTRAINT sites_documenti_non_servono_check
  CHECK (documenti_non_servono <@ ARRAY['pos', 'psc', 'notifica_asl']::text[]);
