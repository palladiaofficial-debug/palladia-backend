'use strict';
// Fase 2, Scaglione 1 — controllo ricorrente per tutto il periodo di doppia
// scrittura (non un gate una tantum dopo il backfill, per richiesta esplicita).
// Gira ogni 20 minuti; logga sempre lo stato, con un warning esplicito se
// emergono disallineamenti o fallimenti di sync non risolti.
const cron = require('node-cron');
const { verifyDocumentsSync } = require('./documentsSyncVerify');

async function runCheck() {
  try {
    const report = await verifyDocumentsSync();
    if (report.ok) {
      console.log(`[documentsSyncVerify] OK — ${report.tables.reduce((n, t) => n + t.documents_count, 0)} righe sincronizzate, 0 anomalie.`);
    } else {
      console.warn('[documentsSyncVerify] ANOMALIE TROVATE:', JSON.stringify({
        tables: report.tables.filter(t => t.mismatched_count > 0 || t.orphaned_count > 0 || t.legacy_count !== t.documents_count),
        unresolvedSyncFailuresCount: report.unresolvedSyncFailuresCount,
      }));
    }
  } catch (e) {
    console.error('[documentsSyncVerify] controllo fallito:', e.message);
  }
}

function startDocumentsSyncVerifyCron() {
  runCheck();
  cron.schedule('*/20 * * * *', runCheck);
}

module.exports = { startDocumentsSyncVerifyCron };
