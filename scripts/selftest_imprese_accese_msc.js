#!/usr/bin/env node
/**
 * scripts/selftest_imprese_accese_msc.js
 *
 * Test di regressione per F-407 (AUDIT.md del frontend): Imprese, contratto di
 * subappalto (F-398) e «Carica documenti» delle imprese (F-401) dipendono dal
 * flag `subappaltatori`, acceso solo per l'azienda E2E. Il titolare di MSC non
 * trovava nessuna di queste funzioni («è tutto bloccato»), mentre i test
 * passavano. Qui si controlla l'azienda vera, non quella di prova.
 */
'use strict';
require('dotenv').config();
const { isFeatureEnabled } = require('../lib/featureFlags');

const MSC = '309e9018-1bcc-4876-9430-99cb89e043dd';
let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
}

(async () => {
  console.log('\n=== selftest_imprese_accese_msc (F-407) ===\n');
  const on = await isFeatureEnabled(MSC, 'subappaltatori');
  check('MSC vede Imprese, contratto e «Carica documenti» (flag subappaltatori acceso)', on === true, on);
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})();
