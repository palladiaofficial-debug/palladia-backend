#!/usr/bin/env node
/**
 * scripts/selftest_smart_import_result_card.js
 *
 * Test di regressione per la ResultCard di POST /smart-import/batches/:id/finish
 * (Fase 3.2 "Ciclo del Risultato"). Non orchestra un upload+classificazione AI
 * reale (lento, costoso, e non è la parte modificata) — crea direttamente un
 * batch minimo con import_items già confermati, chiama l'endpoint reale via
 * HTTP contro il server in esecuzione, verifica la forma della resultCard.
 *
 * Richiede il server in ascolto su TEST_BASE_URL (default localhost:3001) e
 * un JWT valido per la company E2E — se manca, salta con motivo esplicito
 * invece di fallire silenziosamente.
 *
 * Env:
 *   TEST_BASE_URL    Default: http://localhost:3001
 *   E2E_COMPANY_ID   Default: fda73bf5-403a-4a0e-be6d-501e3f3c5c4d
 *   E2E_EMAIL / E2E_PASSWORD   Credenziali del bot E2E per ottenere un JWT reale
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { createClient } = require('@supabase/supabase-js');

const BASE       = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const COMPANY_ID = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
const EMAIL      = process.env.E2E_EMAIL || '';
const PASSWORD   = process.env.E2E_PASSWORD || '';

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.log('\x1b[33mSKIP\x1b[0m selftest_smart_import_result_card: E2E_EMAIL/E2E_PASSWORD non configurati.');
    return;
  }

  console.log('\n\x1b[1msmart-import/batches/:id/finish — ResultCard\x1b[0m');

  const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
  const { data: sess, error: authErr } = await auth.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (authErr) { fail('login bot E2E', authErr.message); return report(); }
  const jwt = sess.session.access_token;

  const { data: batch, error: batchErr } = await supabase.from('import_batches').insert({
    company_id: COMPANY_ID, user_id: sess.user.id, status: 'review', source: 'zip', total_files: 2, processed_files: 2,
  }).select().single();
  if (batchErr) { fail('crea batch di test', batchErr.message); return report(); }

  const { error: itemsErr } = await supabase.from('import_items').insert([
    { batch_id: batch.id, original_name: 'TEST-selftest-1.pdf', destination: 'company_documents', status: 'confirmed' },
    { batch_id: batch.id, original_name: 'TEST-selftest-2.pdf', destination: 'company_documents', status: 'confirmed' },
  ]);
  if (itemsErr) { fail('crea import_items di test', itemsErr.message); }

  try {
    const res = await fetch(`${BASE}/api/v1/smart-import/batches/${batch.id}/finish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': COMPANY_ID, 'Content-Type': 'application/json' },
    });
    const body = await res.json().catch(() => null);

    if (res.ok && body?.summary?.documents_imported === 2) ok('summary.documents_imported riflette i 2 item confermati');
    else fail('summary.documents_imported riflette i 2 item confermati', body);

    const card = body?.resultCard;
    if (card?.fatto?.verified === true && card?.fatto?.verdict?.kind === 'none') ok('resultCard.fatto presente e verificato');
    else fail('resultCard.fatto presente e verificato', card);

    const oreItem = card?.contato?.items?.find(i => i.kind === 'ore_risparmiate');
    if (oreItem && oreItem.isEstimate === true && oreItem.value > 0) ok('resultCard.contato include ore_risparmiate dichiarate come stima');
    else fail('resultCard.contato include ore_risparmiate dichiarate come stima', card?.contato);
  } finally {
    await supabase.from('import_items').delete().eq('batch_id', batch.id);
    await supabase.from('import_batches').delete().eq('id', batch.id);
  }

  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_smart_import_result_card:', e.message);
  process.exit(1);
});
