-- F-212 (AUDIT.md) — il titolare ha sollevato due rischi reali sul flusso
-- "Pagamenti buste paga" (migrazione 215, F-205): (1) il link magic-link per
-- chi paga vale 365 giorni e dà accesso a TUTTE le buste paga di TUTTI i
-- lavoratori dell'azienda con la sola email come barriera — un refuso o un
-- inoltro non ha alcuna seconda rete; (2) nessun consenso esplicito del
-- lavoratore alla condivisione della propria busta paga con un soggetto
-- esterno incaricato dei pagamenti.
--
-- Questa migrazione copre SOLO (2) — il consenso lavoratore. Stesso schema
-- già collaudato per il consenso privacy/GPS (F-178, migrazione 205):
-- un'informativa globale versionata, rapporto 1:1 per lavoratore, due
-- colonne su `workers` invece di una tabella a parte (vedi
-- lib/workerPrivacyConsent.js per il precedente diretto).
-- (1) è risolto solo in codice (routes/v1/payerArea.js: finestra scorrevole
-- di 30 giorni invece di 365, storico visibile ristretto agli ultimi 6
-- mesi) — nessuna migrazione necessaria per quella parte.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS payslip_share_consent_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS payslip_share_consent_version     text;

COMMENT ON COLUMN workers.payslip_share_consent_accepted_at IS 'F-212: consenso esplicito del lavoratore alla condivisione della propria busta paga con il soggetto esterno incaricato dei pagamenti (routes/v1/payerArea.js). NULL = non ancora richiesto o non accettato.';
COMMENT ON COLUMN workers.payslip_share_consent_version IS 'Versione del testo informativa accettata — un bump invalida il consenso esistente e lo richiede di nuovo a tutti (stesso principio di privacy_consent_version).';
