-- Migration 025 — Indici di performance per query frequenti a scala
-- Esegui su Supabase: SQL Editor → incolla e lancia
-- Gli indici CONCURRENTLY non bloccano le scritture in produzione.

-- ── presence_logs — tabella più letta/scritta ─────────────────────────────────
-- Usato da: dashboard oggi, storico cantiere con range date, report CSV
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_presence_logs_company_site_ts
  ON presence_logs (company_id, site_id, timestamp_server DESC);

-- Usato da: storico singolo lavoratore
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_presence_logs_worker_ts
  ON presence_logs (worker_id, timestamp_server DESC);

-- Usato da: dashboard KPI "presenze oggi" aggregato per company
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_presence_logs_company_ts
  ON presence_logs (company_id, timestamp_server DESC);

-- Usato da: punch_atomic — trova l'ultimo evento per (worker, site)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_presence_logs_worker_site_ts
  ON presence_logs (worker_id, site_id, timestamp_server DESC);

-- ── sites ─────────────────────────────────────────────────────────────────────
-- Usato da: GET /api/v1/sites (filtro company + status)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sites_company_status
  ON sites (company_id, status);

-- ── workers ──────────────────────────────────────────────────────────────────
-- Usato da: GET /api/v1/workers (lista lavoratori attivi per company)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_workers_company_active
  ON workers (company_id, is_active);

-- ── worksite_workers ──────────────────────────────────────────────────────────
-- Usato da: organico cantiere, worker count per sito
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_worksite_workers_site_status
  ON worksite_workers (site_id, status);

-- Usato da: cantieri a cui è assegnato un lavoratore
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_worksite_workers_worker
  ON worksite_workers (worker_id);

-- ── worker_device_sessions ────────────────────────────────────────────────────
-- Usato da: scan/identify + scan/punch (lookup sessione per token_hash)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_token_hash
  ON worker_device_sessions (token_hash);

-- Usato da: pulizia sessioni scadute
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_expires_at
  ON worker_device_sessions (expires_at);

-- ── site_coordinator_invites ──────────────────────────────────────────────────
-- Usato da: lookup token CSE / Pro
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_coordinator_invites_token
  ON site_coordinator_invites (token);

-- Usato da: scansione weekly cron scadenze per email
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_coordinator_invites_email_active
  ON site_coordinator_invites (coordinator_email, is_active);

-- ── admin_audit_log ───────────────────────────────────────────────────────────
-- Usato da: GET /api/v1/audit-log (filtro company + data)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_log_company_ts
  ON admin_audit_log (company_id, created_at DESC);
