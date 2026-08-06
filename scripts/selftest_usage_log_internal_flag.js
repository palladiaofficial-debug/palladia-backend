#!/usr/bin/env node
/**
 * scripts/selftest_usage_log_internal_flag.js
 *
 * Test di regressione per lib/ladiaUsageLog.js:logUsage — il campo
 * is_internal. Nato da un incidente reale (2026-08-06): senza il controllo
 * su RAILWAY_ENVIRONMENT, ogni chiamata fatta avviando il server in locale
 * (la normalità di ogni sessione di sviluppo/verifica) veniva marcata come
 * spesa di un cliente reale nei report costi — il giorno stesso in cui
 * is_internal è stato introdotto, un run della suite LADIA_EVALS (~$4,69,
 * 100% del consumo di 12 ore) sarebbe finito interamente classificato come
 * "clienti reali" se non corretto.
 *
 * Verifica tre casi con una company REALE (non master, non founder):
 *   1. Nessuna RAILWAY_ENVIRONMENT (processo locale) → is_internal SEMPRE true.
 *   2. RAILWAY_ENVIRONMENT impostata (come su Railway vero) → is_internal false.
 *   3. RAILWAY_ENVIRONMENT impostata MA MASTER_COMPANY_IDS include la company
 *      → is_internal true comunque (il bypass founder/master resta valido).
 *
 * Nessun server richiesto: logUsage scrive direttamente su Supabase.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');

const REAL_COMPANY_ID = 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }

async function logAndRead(callSite, envOverrides) {
  // Env var mutate PRIMA del require così il modulo (che legge process.env
  // al momento della chiamata, non al load) vede lo stato voluto — logUsage
  // valuta RAILWAY_ENVIRONMENT/MASTER_COMPANY_IDS ad ogni invocazione.
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve('../lib/ladiaUsageLog')];
  const { logUsage } = require('../lib/ladiaUsageLog');
  await logUsage({ companyId: REAL_COMPANY_ID, userId: null, model: 'claude-haiku-4-5-20251001', callSite, usage: { input_tokens: 1, output_tokens: 1 } });
  const { data } = await supabase.from('ladia_usage_log').select('is_internal').eq('call_site', callSite).single();
  await supabase.from('ladia_usage_log').delete().eq('call_site', callSite);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return data?.is_internal;
}

(async () => {
  console.log('\n=== selftest_usage_log_internal_flag ===\n');

  const local = await logAndRead('_test_internal_local', { RAILWAY_ENVIRONMENT: undefined, MASTER_COMPANY_IDS: undefined });
  if (local === true) ok('processo locale (nessuna RAILWAY_ENVIRONMENT) → is_internal true, anche per company reale');
  else fail('processo locale → is_internal true', local);

  const railway = await logAndRead('_test_internal_railway', { RAILWAY_ENVIRONMENT: 'production', MASTER_COMPANY_IDS: undefined, INTERNAL_TEST_COMPANY_IDS: undefined });
  if (railway === false) ok('ambiente Railway + company reale → is_internal false');
  else fail('ambiente Railway + company reale → is_internal false', railway);

  const railwayMaster = await logAndRead('_test_internal_railway_master', { RAILWAY_ENVIRONMENT: 'production', MASTER_COMPANY_IDS: REAL_COMPANY_ID, INTERNAL_TEST_COMPANY_IDS: undefined });
  if (railwayMaster === true) ok('ambiente Railway ma company in MASTER_COMPANY_IDS → is_internal true (bypass founder/master intatto)');
  else fail('ambiente Railway + master company → is_internal true', railwayMaster);

  const railwayTestList = await logAndRead('_test_internal_railway_testlist', { RAILWAY_ENVIRONMENT: 'production', MASTER_COMPANY_IDS: undefined, INTERNAL_TEST_COMPANY_IDS: REAL_COMPANY_ID });
  if (railwayTestList === true) ok('ambiente Railway ma company in INTERNAL_TEST_COMPANY_IDS → is_internal true (allowlist E2E/QA/demo)');
  else fail('ambiente Railway + company in INTERNAL_TEST_COMPANY_IDS → is_internal true', railwayTestList);

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('Errore imprevisto:', e.message); process.exit(1); });
