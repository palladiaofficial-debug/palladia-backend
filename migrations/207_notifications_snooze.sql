-- Migration 207: snooze temporaneo per notifiche di compliance non immediate
-- (idoneità/formazione mancante o in scadenza) — l'utente segnala "prenotato,
-- in fase di rinnovo" invece di ricevere l'alert ogni giorno finché non è
-- davvero risolto. Sempre a scadenza esplicita (snoozed_until), mai
-- indefinito: allo scadere della data, l'alert riprende da solo — e per
-- worker_doc_expiry già scaduto (severity critical) lo snooze non si applica
-- mai (lib/expiryHelper.js::isSnoozeActive), coerente col resto del sistema
-- dove un rischio già concretizzato non è mai silenziabile.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS snoozed_until date;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS snoozed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
