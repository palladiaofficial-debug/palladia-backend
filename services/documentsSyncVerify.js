'use strict';
// Fase 2, Scaglione 1 — verifica ricorrente (non un gate una tantum) della
// sincronizzazione tra le 4 tabelle storiche e `documents`. Chiamata sia dal
// cron periodico sia dallo script CLI on-demand.
const supabase = require('../lib/supabase');

async function verifyDocumentsSync() {
  const { data: tables, error } = await supabase.rpc('verify_documents_sync_tier1');
  if (error) throw new Error(`verify_documents_sync_tier1 fallita: ${error.message}`);

  const { data: unresolvedFailures, error: failErr } = await supabase
    .from('document_sync_failures')
    .select('id, source_table, legacy_id, operation, error_message, occurred_at')
    .is('resolved_at', null)
    .order('occurred_at', { ascending: false })
    .limit(50);
  if (failErr) throw new Error(`lettura document_sync_failures fallita: ${failErr.message}`);

  const anyMismatch  = (tables || []).some(t => t.mismatched_count > 0 || t.orphaned_count > 0 || t.legacy_count !== t.documents_count);
  const anyFailures  = (unresolvedFailures || []).length > 0;

  return {
    ok: !anyMismatch && !anyFailures,
    checkedAt: new Date().toISOString(),
    tables: tables || [],
    unresolvedSyncFailuresCount: (unresolvedFailures || []).length,
    unresolvedSyncFailuresSample: unresolvedFailures || [],
  };
}

module.exports = { verifyDocumentsSync };
