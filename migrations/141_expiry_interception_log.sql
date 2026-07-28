-- ─── 141_expiry_interception_log.sql ──────────────────────────────────────────
-- Layer "proof of value" — parte 2: trail append-only delle notifiche di
-- scadenza, generalizzato a TUTTI i tipi di documento (non solo Formazione).
--
-- Perché serve: `notifications` (migrazione 051) è uno stato LIVE — la riga
-- viene CANCELLATA da pruneNotifications() non appena il problema si risolve
-- (vedi services/expiryHelper.js). Ottimo per l'UI, inutilizzabile per provare
-- "notificato in anticipo POI rinnovato prima della scadenza": la prova sparisce
-- proprio nel momento in cui il dato sarebbe da contare.
--
-- expiry_interception_log è il gemello append-only: scritto (non aggiornato)
-- da services/expiryHelper.js in aggiunta a `notifications`, mai al suo posto.
-- notified_at si valorizza alla prima comparsa del problema; resolved_at si
-- valorizza quando pruneNotifications rileva che il problema non c'è più.
--
-- IMPORTANTE — non retroattivo: i cron scrivono qui da quando questa migrazione
-- è applicata. Non fabbrichiamo eventi passati: value_metrics (step successivo)
-- conterà solo scadenze intercettate a partire da questa data per i tipi diversi
-- da worker_certificates (che ha già un trail append-only proprio, vedi
-- expiry_notifications, migrazione 045/102 — non toccato da questa migrazione).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Fix collaterale: notifications.entity_id è uuid, ma subcontractorExpiryCron
--    passa entity_id compositi (es. "<uuid-subappaltatore>::durc_expiry") per
--    distinguere le 3 scadenze (DURC/assicurazione/SOA) sullo stesso subappaltatore
--    — l'insert falliva silenziosamente (nessun controllo di errore in
--    upsertNotification), quindi le notifiche di scadenza subappaltatori non
--    sono mai state salvate in `notifications` e la relativa risoluzione non è
--    mai stata rilevabile. Scoperto leggendo services/subcontractorExpiryCron.js
--    durante questa migrazione — widening uuid→text è sempre sicuro (i valori
--    uuid esistenti restano validi come testo).
ALTER TABLE notifications ALTER COLUMN entity_id TYPE text USING entity_id::text;

CREATE TABLE IF NOT EXISTS expiry_interception_log (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  notification_type   text        NOT NULL,  -- stesso valore di notifications.type: 'company_doc_expiry' | 'subcontractor_expiry' | 'equipment_expiry' | 'worker_doc_expiry' | 'company_durc_expiry' | 'site_occupazione_expiry'
  entity_type         text        NOT NULL,  -- 'company_document' | 'subcontractor' | 'equipment' | 'worker_document' | 'company' | 'site'
  entity_id           text        NOT NULL,  -- TEXT non uuid: alcuni entity_id sono composti (es. "<uuid>::durc_expiry" per i 3 campi scadenza di subcontractors)
  severity_at_notify  text        NOT NULL CHECK (severity_at_notify IN ('info','warning','critical')),
  notified_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,           -- valorizzato da pruneNotifications() quando il problema esce dal set "in scadenza"
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Un solo evento "aperto" per problema: se lo stesso problema si ripresenta
-- dopo essere stato risolto, si apre un NUOVO ciclo (nuova riga), non si
-- riusa quella vecchia — altrimenti perderemmo la storia dei cicli precedenti.
CREATE UNIQUE INDEX IF NOT EXISTS idx_expiry_interception_open
  ON expiry_interception_log (company_id, entity_type, entity_id, notification_type)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_expiry_interception_company
  ON expiry_interception_log (company_id, notified_at DESC);

CREATE INDEX IF NOT EXISTS idx_expiry_interception_resolved
  ON expiry_interception_log (company_id, resolved_at)
  WHERE resolved_at IS NOT NULL;

ALTER TABLE expiry_interception_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expiry_interception_log_select_own" ON expiry_interception_log;
CREATE POLICY "expiry_interception_log_select_own"
  ON expiry_interception_log FOR SELECT
  TO authenticated
  USING (is_company_member(company_id));

-- Nessuna policy INSERT/UPDATE per authenticated: scritto solo dai cron
-- (service_role) via services/expiryHelper.js.
