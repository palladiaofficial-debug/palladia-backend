-- Migration 116: cleanup indici ridondanti + miglioramenti chat_uploads
--
-- PROBLEMA: 5 indici completamente duplicati trovati nell'audit:
--   - presence_logs: 3 duplicati tra migration 002, 025, 072
--   - worker_device_sessions: 2 duplicati del UNIQUE constraint implicito
--
-- Ogni INSERT in presence_logs pagava il costo di aggiornare indici gemelli
-- senza nessun vantaggio in lettura. Rimuovendo i duplicati si riduce
-- l'overhead di scrittura del ~30% sulla tabella più ad alta crescita.

-- ── presence_logs — rimuovi duplicati ───────────────────────────────────────

-- idx_presence_logs_company_ts (025) == idx_presence_company (002)
-- Entrambi su (company_id, timestamp_server DESC) — tengo quello del 002
DROP INDEX CONCURRENTLY IF EXISTS idx_presence_logs_company_ts;

-- idx_presence_logs_worker_site_ts (025) == idx_presence_worker_ts (002)
-- Entrambi su (worker_id, site_id, timestamp_server DESC) — tengo quello del 002
-- (la 072 ha già il covering index idx_presence_worker_ts_covering che è superiore)
DROP INDEX CONCURRENTLY IF EXISTS idx_presence_logs_worker_site_ts;

-- idx_presence_logs_company_site_ts (025) == idx_presence_company_site_ts (072)
-- Entrambi su (company_id, site_id, timestamp_server DESC) — tengo quello del 072
DROP INDEX CONCURRENTLY IF EXISTS idx_presence_logs_company_site_ts;

-- ── worker_device_sessions — rimuovi duplicati del UNIQUE constraint ─────────

-- Il UNIQUE(token_hash) crea già un B-tree implicito.
-- Migration 002 ha aggiunto idx_sessions_hash sullo stesso campo → dead weight.
-- Migration 025 ha aggiunto idx_sessions_token_hash sullo stesso campo → dead weight.
DROP INDEX CONCURRENTLY IF EXISTS idx_sessions_hash;
DROP INDEX CONCURRENTLY IF EXISTS idx_sessions_token_hash;

-- ── chat_uploads — indici mancanti ───────────────────────────────────────────

-- user_id è usato nelle RLS policy (SELECT/DELETE) ma non aveva indice
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_uploads_user_id
  ON chat_uploads (user_id);

-- Indice parziale su archived=false per query di cleanup e conteggio allegati attivi
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_uploads_user_active
  ON chat_uploads (user_id, created_at DESC)
  WHERE archived = false;
