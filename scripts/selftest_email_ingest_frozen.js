#!/usr/bin/env node
/**
 * scripts/selftest_email_ingest_frozen.js
 *
 * Test di regressione per F-106 (AUDIT.md, 2026-09-01): il wizard "Fatture via
 * Email" istruiva l'utente a impostare un inoltro su TUTTI i messaggi in
 * arrivo della propria casella, senza mai avvisare che questo devia l'intera
 * corrispondenza — un cliente l'ha impostato sulla casella principale della
 * sua azienda e ha smesso di ricevere ogni email per giorni, scoperto solo
 * quando l'assistenza del suo provider ha trovato la regola.
 *
 * Nuove attivazioni (`connect`) e nuove deleghe (`delegate`) sono sospese via
 * FROZEN_FEATURES finché non esiste un percorso sicuro. Questo test protegge
 * sia dall'env var sbagliata sia da FROZEN_FEATURES rimosso per errore —
 * stesso pattern di selftest_dvr_pimus_feature_gate.js.
 *
 * Nessun server richiesto: isFeatureEnabled è testabile direttamente.
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
  console.log('\n=== selftest_email_ingest_frozen (F-106) ===\n');

  if (process.env.FEATURE_EMAIL_INGEST_MANUAL_FORWARD_SETUP_DEFAULT === 'true') {
    fail("FEATURE_EMAIL_INGEST_MANUAL_FORWARD_SETUP_DEFAULT non è 'true' in questo ambiente", process.env.FEATURE_EMAIL_INGEST_MANUAL_FORWARD_SETUP_DEFAULT);
  } else {
    ok("FEATURE_EMAIL_INGEST_MANUAL_FORWARD_SETUP_DEFAULT non è 'true' in questo ambiente (locale/CI)");
  }

  const realCompany = await isFeatureEnabled(REAL_COMPANY_ID, 'email_ingest_manual_forward_setup');
  if (realCompany === false) ok('email_ingest_manual_forward_setup disattivato per una company reale senza override');
  else fail('email_ingest_manual_forward_setup disattivato per una company reale senza override', realCompany);

  if (MASTER_COMPANY_ID) {
    const masterCompany = await isFeatureEnabled(MASTER_COMPANY_ID, 'email_ingest_manual_forward_setup');
    if (masterCompany === false) ok('email_ingest_manual_forward_setup resta disattivato ANCHE per la master company (FROZEN_FEATURES, nessuna eccezione)');
    else fail('email_ingest_manual_forward_setup disattivato per la master company', masterCompany);
  } else {
    console.log('  \x1b[33m–\x1b[0m test master company (skip: MASTER_COMPANY_IDS non impostata in questo ambiente)');
  }

  // Verifica diretta sulle route, non solo sul flag: connect/delegate devono
  // rifiutare con FEATURE_DISABLED prima di toccare il DB, senza guardia
  // aggirabile passando semplicemente un ruolo owner/admin.
  const emailIngestSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'v1', 'emailIngest.js'), 'utf8');
  const connectBlock = emailIngestSource.split("router.post('/expenses/email-ingest/connect'")[1]?.split("router.post('/expenses/email-ingest/rotate-token'")[0] || '';
  const delegateBlock = emailIngestSource.split("router.post('/expenses/email-ingest/delegate'")[1] || '';

  if (connectBlock.includes("isFeatureEnabled(req.companyId, 'email_ingest_manual_forward_setup')")) {
    ok('POST /expenses/email-ingest/connect controlla email_ingest_manual_forward_setup prima di creare la configurazione');
  } else {
    fail('POST /expenses/email-ingest/connect controlla email_ingest_manual_forward_setup prima di creare la configurazione');
  }

  if (delegateBlock.includes("isFeatureEnabled(req.companyId, 'email_ingest_manual_forward_setup')")) {
    ok('POST /expenses/email-ingest/delegate controlla email_ingest_manual_forward_setup prima di inviare le istruzioni a terzi');
  } else {
    fail('POST /expenses/email-ingest/delegate controlla email_ingest_manual_forward_setup prima di inviare le istruzioni a terzi');
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  console.error('Errore imprevisto:', e.message);
  process.exit(1);
});
