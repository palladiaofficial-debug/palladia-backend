-- 251 — F-340 (AUDIT.md del frontend): sunto del POS in timbratura dal badge.
-- La presa visione (pos_acknowledgments, migr. 091) ora arriva anche dal badge
-- (public/badge-punch.html, il canale vero delle timbrature). Il titolare vede
-- come è stata data:
--   canale          'badge' (sunto a schede) | null (vecchia pagina /timbra, F-260)
--   lingua          lingua in cui l'operaio ha letto il sunto (it, ro, sq, ar)
--   schede          id delle schede mostrate, nell'ordine
--   secondi_schede  secondi passati su ogni scheda, stesso ordine
-- Le righe vecchie restano valide (colonne vuote = vecchia pagina).
ALTER TABLE pos_acknowledgments
  ADD COLUMN IF NOT EXISTS canale         text,
  ADD COLUMN IF NOT EXISTS lingua         text,
  ADD COLUMN IF NOT EXISTS schede         text[],
  ADD COLUMN IF NOT EXISTS secondi_schede integer[];
