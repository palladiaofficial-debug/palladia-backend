#!/usr/bin/env node
/**
 * scripts/selftest_ladia_generic_tools.js
 *
 * Verifica manuale (non in npm test) del registro/executor generico dei tool
 * Ladia introdotti in lib/ladiaSchemaRegistry.js + lib/ladiaGenericTools.js.
 * Da rilanciare ogni volta che si tocca il registro.
 *
 * Env (default = utente CI di scripts/selftest_api.js):
 *   TEST_COMPANY_ID   Default: d5dd4e79-635b-4ceb-ae74-9548a1dcfee1
 *   TEST_SITE_ID      Default: b4d201dd-4721-42bb-89b9-2736f6e52038
 *
 * Uso: node scripts/selftest_ladia_generic_tools.js
 */
'use strict';
require('dotenv').config();

const supabase = require('../lib/supabase');
const { RESOURCES, sanitizePayload, computeSensitivity } = require('../lib/ladiaSchemaRegistry');
const { createRecord, updateRecord, deleteRecord } = require('../lib/ladiaGenericTools');

const COMPANY_ID = process.env.TEST_COMPANY_ID || 'd5dd4e79-635b-4ceb-ae74-9548a1dcfee1';
const OTHER_COMPANY_ID = '00000000-0000-0000-0000-000000000000'; // finto, usato solo per il test di injection
const SITE_ID     = process.env.TEST_SITE_ID    || 'b4d201dd-4721-42bb-89b9-2736f6e52038';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\n=== 1. sanitizePayload rifiuta sempre company_id/id/pk per ogni risorsa ===\n');
  for (const [name, resource] of Object.entries(RESOURCES)) {
    const malicious = { company_id: 'HACKED', id: 'HACKED', [resource.pk]: 'HACKED' };
    const { clean } = sanitizePayload(resource, malicious, 'create');
    check(`${name}: company_id/id/${resource.pk} non passano mai in create`, !('company_id' in clean) && !('id' in clean) && !(resource.pk in clean), clean);
  }

  console.log('\n=== 2. computeSensitivity riconosce campi sensibili anche su tabelle "low" ===\n');
  const fakeResourceWithMedium = {
    defaultSensitivity: 'low',
    fields: { safe: { sensitivity: 'low' }, risky: { sensitivity: 'medium' } },
  };
  check('sensibilità low se tocco solo campi low', computeSensitivity(fakeResourceWithMedium, ['safe']) === 'low');
  check('sensibilità sale a medium se tocco un campo medium', computeSensitivity(fakeResourceWithMedium, ['safe', 'risky']) === 'medium');

  console.log('\n=== 3. createRecord — company_id iniettato server-side, mai dal payload ===\n');
  const bookingResult = await createRecord('site_bookings', {
    company_id: OTHER_COMPANY_ID, // il modello prova a "scappare" dal tenant — deve essere ignorato
    site_id: SITE_ID,
    title: 'Selftest — consegna di prova',
    booking_date: new Date().toISOString().slice(0, 10),
  }, COMPANY_ID, null, null);
  check('create_record su site_bookings riesce', bookingResult.success === true, bookingResult);
  check('company_id iniettato è quello reale, non quello del payload malevolo', bookingResult.record?.company_id === COMPANY_ID, bookingResult.record);
  if (bookingResult.record?.id) {
    await supabase.from('site_bookings').delete().eq('id', bookingResult.record.id); // cleanup
  }

  console.log('\n=== 4. createRecord su risorsa non gestita torna errore esplicito ===\n');
  const unknown = await createRecord('pos_documents', { foo: 'bar' }, COMPANY_ID, null, null);
  check('risorsa non nel registro → RISORSA_NON_GESTIBILE_GENERICAMENTE (mai un insert silenzioso)', unknown.error === 'RISORSA_NON_GESTIBILE_GENERICAMENTE' || unknown.error?.includes('non gestita'), unknown);

  console.log('\n=== 5. createRecord su worksite_workers è idempotente (dedupeCheck) ===\n');
  // Richiede un worker_id reale del company di test — se non presente, skip silenzioso.
  const { data: anyWorker } = await supabase.from('workers').select('id').eq('company_id', COMPANY_ID).limit(1).maybeSingle();
  if (anyWorker) {
    const first  = await createRecord('worksite_workers', { worker_id: anyWorker.id, site_id: SITE_ID }, COMPANY_ID, null, null);
    const second = await createRecord('worksite_workers', { worker_id: anyWorker.id, site_id: SITE_ID }, COMPANY_ID, null, null);
    check('prima assegnazione riesce', first.success === true, first);
    check('seconda assegnazione è idempotente (already_exists), non duplica la riga', second.already_exists === true, second);
    if (first.record?.id && !first.already_exists) {
      await supabase.from('worksite_workers').delete().eq('id', first.record.id); // cleanup — solo se creata ora da questo test
    }
  } else {
    console.log('  – skip (nessun worker di test trovato per il company_id di test)');
  }

  console.log('\n=== 6. updateRecord rifiuta se non ci sono campi validi ===\n');
  const emptyUpdate = await updateRecord('sites', SITE_ID, { unknown_field: 'x' }, COMPANY_ID, null, null);
  check('update con solo campi non whitelisted → errore, nessuna query eseguita', emptyUpdate.error === 'Nessun campo da aggiornare specificato', emptyUpdate);

  console.log('\n=== 7. deleteRecord su risorsa senza allow.delete è bloccato ===\n');
  const del = await deleteRecord('sites', SITE_ID, COMPANY_ID, null, null);
  check('delete su sites (allow.delete=false) è rifiutato', del.error === 'RISORSA_NON_GESTIBILE_GENERICAMENTE', del);

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Errore fatale:', e); process.exit(1); });
