-- Migration 228: workers.ddt_upload_enabled — abilitazione per-lavoratore al
-- caricamento DDT da badge (routes/v1/badgeDdt.js, F-213/F-214).
--
-- Richiesto esplicitamente dal titolare, 2026-09-23: il bottone "Carica DDT"
-- era visibile a QUALUNQUE lavoratore col badge (chiunque avesse un badge
-- attivo, anche chi non fa consegne) — "fa confusione". Ora è un flag
-- esplicito per lavoratore, attivato/disattivato dall'Organico, default
-- FALSE: nessun lavoratore esistente lo vede finché non viene abilitato a
-- mano — nessuna regressione silenziosa su chi già lo usava (Petriccione
-- Raffaele, Daniel Miosi verranno riabilitati subito dopo il deploy).

ALTER TABLE workers ADD COLUMN IF NOT EXISTS ddt_upload_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN workers.ddt_upload_enabled IS
  'Abilita il bottone "Carica DDT" sulla pagina badge (public/badge-punch.html). Attivato dall''Organico, per singolo lavoratore. Default false.';
