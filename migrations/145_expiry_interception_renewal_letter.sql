-- Migration 145 — Fase 3.4 "Ciclo del Risultato": flusso scadenza→rinnovo.
--
-- superseded_by_action_history_id: quando un rinnovo (archive_document) risolve
-- SUBITO una riga expiry_interception_log ancora aperta (invece di aspettare
-- il prossimo giro cron, vedi services/expiryHelper.js:pruneNotifications),
-- questa colonna traccia QUALE scrittura l'ha risolta — rende il "Contato"
-- della ResultCard di rinnovo tracciabile a un evento preciso, non solo un
-- conteggio scollegato.
ALTER TABLE expiry_interception_log
  ADD COLUMN IF NOT EXISTS superseded_by_action_history_id uuid REFERENCES ladia_action_history(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expiry_interception_superseded_by
  ON expiry_interception_log (superseded_by_action_history_id)
  WHERE superseded_by_action_history_id IS NOT NULL;
