#!/usr/bin/env node
/**
 * scripts/selftest_worker_fiscal_code_required.js
 *
 * Regressione F-028 (AUDIT.md): create_record('workers', ...) permetteva a
 * Ladia di creare un lavoratore senza codice fiscale (fiscal_code: null),
 * bypassando la stessa protezione applicativa presente su POST /workers
 * (routes/v1/workers.js:69-74). Riprodotto da LADIA_EVALS scenario D02.
 *
 * Uso: node scripts/selftest_worker_fiscal_code_required.js
 */
'use strict';
require('dotenv').config();

const supabase = require('../lib/supabase');
const { createRecord } = require('../lib/ladiaGenericTools');

const COMPANY_ID = process.env.TEST_COMPANY_ID || 'd5dd4e79-635b-4ceb-ae74-9548a1dcfee1';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\n=== F-028: create_record(workers) senza/con fiscal_code non valido ===\n');

  const noCf = await createRecord('workers', { full_name: 'Regressione F-028' }, COMPANY_ID, null, null);
  check('fiscal_code assente → errore, nessun worker creato', noCf.error === 'Campi obbligatori mancanti: fiscal_code', noCf);
  if (noCf.record?.id) await supabase.from('workers').delete().eq('id', noCf.record.id); // non dovrebbe mai servire

  const nullCf = await createRecord('workers', { full_name: 'Regressione F-028', fiscal_code: null }, COMPANY_ID, null, null);
  check('fiscal_code: null → errore, nessun worker creato', nullCf.error === 'Campi obbligatori mancanti: fiscal_code', nullCf);
  if (nullCf.record?.id) await supabase.from('workers').delete().eq('id', nullCf.record.id);

  const badCf = await createRecord('workers', { full_name: 'Regressione F-028', fiscal_code: 'non-un-cf' }, COMPANY_ID, null, null);
  check('fiscal_code con formato non valido → errore, nessun worker creato', badCf.error?.startsWith('Campi non validi:') && badCf.error.includes('fiscal_code'), badCf);
  if (badCf.record?.id) await supabase.from('workers').delete().eq('id', badCf.record.id);

  const validCf = 'RSSMRA85M01H501Z';
  const goodCf = await createRecord('workers', { full_name: 'Regressione F-028', fiscal_code: validCf }, COMPANY_ID, null, null);
  check('fiscal_code valido → creazione riesce normalmente', goodCf.success === true && goodCf.record?.fiscal_code === validCf, goodCf);
  if (goodCf.record?.id) await supabase.from('workers').delete().eq('id', goodCf.record.id); // cleanup

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Errore fatale:', e); process.exit(1); });
