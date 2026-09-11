#!/usr/bin/env node
/**
 * scripts/selftest_sites_update_no_default_wipe.js
 *
 * Test di regressione per F-175 (AUDIT.md, 2026-09-11): sanitizePayload
 * (lib/ladiaSchemaRegistry.js) applicava il valore di default di un campo
 * anche in update, non solo in create. Per `sites.address` (default: () =>
 * ''), questo significa che QUALUNQUE update_record su un cantiere che non
 * tocca esplicitamente address lo azzera silenziosamente — riprodotto dal
 * vivo scoprendolo durante la verifica di non-regressione di F-174.
 *
 * Verifica diretta sul DB, non sul solo valore di ritorno: crea un cantiere
 * fixture con un indirizzo reale, chiama updateRecord su un campo che non
 * c'entra nulla con address, rilegge la riga dal DB e verifica che address
 * sia rimasto invariato.
 *
 * Env:
 *   E2E_COMPANY_ID   Default: fda73bf5-403a-4a0e-be6d-501e3f3c5c4d
 *   E2E_USER_ID      Owner della company E2E — nessun default, obbligatorio
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { updateRecord } = require('../lib/ladiaGenericTools');

const COMPANY_ID = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const USER_ID    = process.env.E2E_USER_ID || '';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }

async function main() {
  if (!USER_ID) {
    console.log('\x1b[33mSKIP\x1b[0m selftest_sites_update_no_default_wipe: E2E_USER_ID non configurato.');
    return;
  }

  console.log('\n\x1b[1msites — F-175: update_record non deve azzerare address quando non lo tocca\x1b[0m');

  const REAL_ADDRESS = 'Via Reale 123, Genova';
  const { data: site, error: siteErr } = await supabase.from('sites').insert({
    company_id: COMPANY_ID, name: 'TEST-E2E-F175 Cantiere', status: 'attivo', address: REAL_ADDRESS,
  }).select('id, address').single();
  if (siteErr) { fail('setup cantiere fixture con indirizzo reale', siteErr.message); return report(); }

  // Update che tocca SOLO status — nessuna intenzione di modificare address,
  // esattamente come farebbe Ladia per "sospendi il cantiere X".
  const r = await updateRecord('sites', site.id, { status: 'sospeso' }, COMPANY_ID, USER_ID, null, {});
  if (!r.success) { fail('updateRecord(sites, {status}) esegue con successo', r); }

  const { data: after } = await supabase.from('sites').select('address, status').eq('id', site.id).maybeSingle();
  if (after?.address === REAL_ADDRESS) {
    ok('address invariato dopo un update che non lo tocca (verificato leggendo dal DB)');
  } else {
    fail('address invariato dopo un update che non lo tocca (verificato leggendo dal DB)', after);
  }
  if (after?.status === 'sospeso') {
    ok('il campo effettivamente richiesto (status) è stato aggiornato correttamente');
  } else {
    fail('il campo effettivamente richiesto (status) è stato aggiornato correttamente', after);
  }

  await supabase.from('sites').delete().eq('id', site.id);
  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_sites_update_no_default_wipe:', e.message);
  process.exit(1);
});
