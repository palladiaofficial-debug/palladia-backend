-- 241 — Seconda prova della coordinatrice sul PSC (AUDIT.md del frontend, 2026-10-09)
-- F-305: entità presunta del cantiere in uomini-giorno, scritta dal coordinatore
--        (prima era solo la somma di valori predefiniti per lavorazione).
-- F-313: le osservazioni libere sul contesto usano testi.descrizione_contesto (già nel PDF).
-- F-311: dati dell'impresa che il PSC deve riportare (come nei PSC fatti con ACCA).

ALTER TABLE psc_projects ADD COLUMN IF NOT EXISTS uomini_giorno numeric(10,1);

ALTER TABLE psc_imprese ADD COLUMN IF NOT EXISTS datore_lavoro   text;
ALTER TABLE psc_imprese ADD COLUMN IF NOT EXISTS indirizzo       text;
ALTER TABLE psc_imprese ADD COLUMN IF NOT EXISTS cap             text;
ALTER TABLE psc_imprese ADD COLUMN IF NOT EXISTS citta           text;
ALTER TABLE psc_imprese ADD COLUMN IF NOT EXISTS codice_fiscale  text;
ALTER TABLE psc_imprese ADD COLUMN IF NOT EXISTS posizione_inps  text;
ALTER TABLE psc_imprese ADD COLUMN IF NOT EXISTS posizione_inail text;
ALTER TABLE psc_imprese ADD COLUMN IF NOT EXISTS cassa_edile     text;
ALTER TABLE psc_imprese ADD COLUMN IF NOT EXISTS art97_nome      text;
ALTER TABLE psc_imprese ADD COLUMN IF NOT EXISTS art97_mansione  text;

-- F-308: "Non è un'interferenza" — lavorazioni contemporanee per scelta del coordinatore
ALTER TABLE psc_interferenze DROP CONSTRAINT IF EXISTS psc_interferenze_soluzione_check;
ALTER TABLE psc_interferenze ADD CONSTRAINT psc_interferenze_soluzione_check CHECK (soluzione IN ('temporale', 'spaziale', 'misure', 'compatibili'));
