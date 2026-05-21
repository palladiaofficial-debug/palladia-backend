'use strict';
/**
 * services/formazioneMigration.js
 * Migrazione one-shot: sincronizza i worker_documents formativi esistenti
 * verso worker_certificates (tab Formazione).
 *
 * Viene eseguita automaticamente all'avvio del server.
 * Guard: salta silenziosamente se già eseguita (verifica via tabella app_migrations).
 * Se la tabella non esiste, esegue comunque — è idempotente.
 */

const supabase = require('../lib/supabase');
const { syncToFormazione } = require('./documentAI');

const MIGRATION_KEY  = 'formazione_backfill_v1';
const FORMAZIONE_TYPES = [
  'formazione_sicurezza', 'primo_soccorso', 'antincendio',
  'lavori_quota', 'ponteggi', 'gruista',
];

async function isMigrationDone() {
  const { data, error } = await supabase
    .from('app_migrations')
    .select('key')
    .eq('key', MIGRATION_KEY)
    .maybeSingle();
  if (error) return false; // tabella inesistente o errore DB → procedi
  return !!data;
}

async function markMigrationDone(stats) {
  const { error } = await supabase.from('app_migrations').upsert({
    key:    MIGRATION_KEY,
    ran_at: new Date().toISOString(),
    meta:   stats,
  }, { onConflict: 'key' });
  if (error) console.warn('[migration] markDone fallita (tabella mancante?):', error.message);
}

async function runFormazioneMigration() {
  if (await isMigrationDone()) return; // già eseguita

  console.log('[migration] formazione_backfill_v1 — avvio...');

  const { data: docs, error } = await supabase
    .from('worker_documents')
    .select('id, company_id, worker_id, doc_type, name, issued_date, expiry_date, ai_expiry_date, ai_issued_by, file_url')
    .in('doc_type', FORMAZIONE_TYPES)
    .limit(5000);

  if (error) {
    console.error('[migration] lettura worker_documents fallita:', error.message);
    return;
  }

  const stats = { total: docs.length, processed: 0, skipped: 0, errors: 0 };

  for (const doc of docs) {
    const expiryDate = doc.expiry_date || doc.ai_expiry_date;
    if (!expiryDate) { stats.skipped++; continue; }

    try {
      await syncToFormazione(
        doc.id, doc.worker_id, doc.company_id,
        doc.doc_type, doc.name,
        doc.issued_date, expiryDate,
        doc.ai_issued_by, doc.file_url,
      );
      stats.processed++;
    } catch (e) {
      console.error('[migration] doc', doc.id, e.message);
      stats.errors++;
    }
  }

  await markMigrationDone(stats);
  console.log(`[migration] formazione_backfill_v1 completata:`, stats);
}

module.exports = { runFormazioneMigration };
