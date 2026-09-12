-- ================================================================
-- Migration 205 — consenso privacy/GPS verificato dal server (F-178,
-- AUDIT.md). L'unico "consenso" esistente prima era un flag localStorage
-- cosmetico (public/scan.html), mai controllato server-side. Nessun
-- default/backfill: NULL per ogni lavoratore, esistente o nuovo, finché
-- non accetta davvero — nessuno ha mai dato un consenso verificabile.
-- ================================================================

ALTER TABLE workers ADD COLUMN IF NOT EXISTS privacy_consent_accepted_at timestamptz;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS privacy_consent_version text;

COMMENT ON COLUMN workers.privacy_consent_accepted_at IS
  'Consenso verificato server-side all''informativa privacy/GPS (F-178). Vedi lib/workerPrivacyConsent.js.';
COMMENT ON COLUMN workers.privacy_consent_version IS
  'Versione dell''informativa accettata — un bump futuro richiede nuovo consenso a tutti.';
