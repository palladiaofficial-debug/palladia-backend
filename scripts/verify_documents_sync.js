#!/usr/bin/env node
/**
 * scripts/verify_documents_sync.js
 *
 * Verifica on-demand della sincronizzazione documents (tutti gli scaglioni
 * attivi). Stesso controllo del cron (services/documentsSyncVerifyCron.js),
 * ma per un run manuale con output leggibile. Exit code 1 se trova anomalie —
 * utilizzabile anche in CI/monitoring.
 */
'use strict';
require('dotenv').config();
const { verifyDocumentsSync } = require('../services/documentsSyncVerify');

async function main() {
  console.log('\nVerifica sincronizzazione documents\n');
  const report = await verifyDocumentsSync();

  for (const t of report.tables) {
    const rowOk = t.mismatched_count === 0 && t.orphaned_count === 0 && t.legacy_count === t.documents_count;
    const mark = rowOk ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${mark} ${t.source_table.padEnd(22)} legacy=${t.legacy_count} documents=${t.documents_count} mismatch=${t.mismatched_count} orfane=${t.orphaned_count}`);
  }

  console.log(`\n  Fallimenti di sync non risolti: ${report.unresolvedSyncFailuresCount}`);
  for (const f of report.unresolvedSyncFailuresSample.slice(0, 10)) {
    console.log(`    - ${f.occurred_at} ${f.source_table}/${f.legacy_id} (${f.operation}): ${f.error_message}`);
  }

  console.log(`\n${report.ok ? '\x1b[32mOK — nessuna anomalia\x1b[0m' : '\x1b[31mANOMALIE TROVATE\x1b[0m'}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch(e => { console.error('Errore:', e.message); process.exitCode = 1; });
