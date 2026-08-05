-- ═══════════════════════════════════════════════════════════════════════════
-- Combinato: migrazioni 144 + 145 + 146 — "Il Ciclo del Risultato"
-- Incollare una sola volta nell'SQL Editor di Supabase.
-- (Il vincolo document_exports_export_type_check viene toccato sia da 144 che
-- da 146: qui è unito in un solo DROP+ADD con la lista finale completa,
-- invece di farlo due volte in sequenza — stesso risultato, meno rumore.)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 144 + 146 (parte condivisa): nuovi tipi di export ────────────────────────
ALTER TABLE document_exports DROP CONSTRAINT document_exports_export_type_check;
ALTER TABLE document_exports ADD CONSTRAINT document_exports_export_type_check
  CHECK (export_type IN (
    'contratto_subappalto', 'report_chat_pdf', 'report_chat_excel', 'report_vigilanza',
    'brief_pdf', 'presence_day_closure'
  ));

-- ── 145: flusso scadenza→rinnovo ─────────────────────────────────────────────
ALTER TABLE expiry_interception_log
  ADD COLUMN IF NOT EXISTS superseded_by_action_history_id uuid REFERENCES ladia_action_history(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expiry_interception_superseded_by
  ON expiry_interception_log (superseded_by_action_history_id)
  WHERE superseded_by_action_history_id IS NOT NULL;

-- ── 146: chiusura giornata presenze ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS presence_day_closures (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id                     uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  closure_date                date        NOT NULL,
  closed_by                   uuid,
  closed_at                   timestamptz NOT NULL DEFAULT now(),
  presence_report_export_id   uuid        REFERENCES document_exports(id) ON DELETE SET NULL,
  worker_count                int         NOT NULL DEFAULT 0,
  total_hours                 numeric     NOT NULL DEFAULT 0,
  locked                      boolean     NOT NULL DEFAULT true,
  UNIQUE (company_id, site_id, closure_date)
);

CREATE INDEX IF NOT EXISTS idx_presence_day_closures_site
  ON presence_day_closures (site_id, closure_date DESC);

ALTER TABLE presence_day_closures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "presence_day_closures_select_own" ON presence_day_closures;
CREATE POLICY "presence_day_closures_select_own"
  ON presence_day_closures FOR SELECT
  TO authenticated
  USING (is_company_member(company_id));

-- Nessuna policy INSERT/UPDATE/DELETE per authenticated: scritto solo dal
-- backend (service_role) via routes/v1/reports.js, dopo aver riverificato
-- che non restino anomalie di pairing irrisolte per la giornata.
