#!/usr/bin/env node
/**
 * scripts/selftest_dvr_pimus_feature_gate.js
 *
 * Test di regressione per lib/featureFlags.js:isFeatureEnabled su dvr/pimus.
 * Nato da un incidente reale (2026-08-06): FEATURE_DVR_DEFAULT era 'true' su
 * Railway produzione nonostante la decisione esplicita "niente DVR/PIMUS" e il
 * commento nel codice stesso — nessun cliente l'aveva ancora usato (0 righe in
 * dvr_documents) ma la generazione era comunque raggiungibile per ogni azienda.
 * Corretto rimettendo la variabile a 'false'. Questo test protegge sia
 * dall'env var sbagliata sia da FROZEN_FEATURES rimosso per errore (che
 * darebbe accesso alla master company anche a funzioni congelate).
 *
 * Nessun server richiesto: isFeatureEnabled è testabile direttamente (usa
 * solo env var + una query DB per gli override per-company).
 */
'use strict';
require('dotenv').config();
const { isFeatureEnabled } = require('../lib/featureFlags');

const MASTER_COMPANY_ID = (process.env.MASTER_COMPANY_IDS || '').split(',')[0]?.trim() || null;
const REAL_COMPANY_ID   = 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }

(async () => {
  console.log('\n=== selftest_dvr_pimus_feature_gate ===\n');

  if (process.env.FEATURE_DVR_DEFAULT === 'true') {
    fail("FEATURE_DVR_DEFAULT non è 'true' in questo ambiente", process.env.FEATURE_DVR_DEFAULT);
  } else {
    ok("FEATURE_DVR_DEFAULT non è 'true' in questo ambiente (locale/CI)");
  }

  const dvrReal = await isFeatureEnabled(REAL_COMPANY_ID, 'dvr');
  if (dvrReal === false) ok('dvr disattivato per una company reale senza override');
  else fail('dvr disattivato per una company reale senza override', dvrReal);

  const pimusReal = await isFeatureEnabled(REAL_COMPANY_ID, 'pimus');
  if (pimusReal === false) ok('pimus disattivato per una company reale senza override');
  else fail('pimus disattivato per una company reale senza override', pimusReal);

  if (MASTER_COMPANY_ID) {
    const dvrMaster = await isFeatureEnabled(MASTER_COMPANY_ID, 'dvr');
    if (dvrMaster === false) ok('dvr resta disattivato ANCHE per la master company (FROZEN_FEATURES, nessuna eccezione)');
    else fail('dvr disattivato per la master company', dvrMaster);

    const pimusMaster = await isFeatureEnabled(MASTER_COMPANY_ID, 'pimus');
    if (pimusMaster === false) ok('pimus resta disattivato ANCHE per la master company (FROZEN_FEATURES, nessuna eccezione)');
    else fail('pimus disattivato per la master company', pimusMaster);
  } else {
    console.log('  \x1b[33m–\x1b[0m test master company (skip: MASTER_COMPANY_IDS non impostata in questo ambiente)');
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  console.error('Errore imprevisto:', e.message);
  process.exit(1);
});
