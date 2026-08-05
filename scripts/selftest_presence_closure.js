#!/usr/bin/env node
/**
 * scripts/selftest_presence_closure.js
 *
 * Test di regressione per POST /reports/presence/close (Fase 3.5 "Ciclo del
 * Risultato" — chiusura giornata presenze). Chiama l'endpoint reale via HTTP
 * (richiede il server in ascolto, come selftest_smart_import_result_card.js)
 * contro un cantiere/timbrature di test creati direttamente via DB.
 *
 * Verifica:
 *   1. Una giornata con timbrature pulite (ENTRY+EXIT accoppiate) si chiude
 *      con successo e produce una ResultCard con Contato.
 *   2. Una richiesta di richiusura della STESSA giornata viene rifiutata
 *      (ALREADY_CLOSED), non sovrascritta in silenzio.
 *   3. Una giornata con un'anomalia (ENTRY senza EXIT — turno ancora aperto)
 *      viene rifiutata (ANOMALIES_UNRESOLVED) — la riverifica blocca
 *      davvero, non è un lock burocratico.
 *
 * Richiede migrations/146_presence_day_closures.sql applicata — se manca,
 * fallisce con un errore esplicito (tabella inesistente), non un falso
 * positivo silenzioso.
 *
 * Env: TEST_BASE_URL, E2E_COMPANY_ID, E2E_EMAIL/E2E_PASSWORD.
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

async function closeDay(jwt, siteId, date) {
  const res = await fetch(`${BASE}/api/v1/reports/presence/close`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': COMPANY_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ site_id: siteId, closure_date: date }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.log('\x1b[33mSKIP\x1b[0m selftest_presence_closure: E2E_EMAIL/E2E_PASSWORD non configurati.');
    return;
  }
  console.log('\n\x1b[1mPOST /reports/presence/close — chiusura giornata\x1b[0m');

  const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
  const { data: sess, error: authErr } = await auth.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (authErr) { fail('login bot E2E', authErr.message); return report(); }
  const jwt = sess.session.access_token;

  const { data: site, error: siteErr } = await supabase.from('sites').insert({
    company_id: COMPANY_ID, name: 'TEST-E2E-presence-closure', status: 'attivo', address: 'Via Test 1, Genova',
  }).select('id').single();
  if (siteErr) { fail('crea cantiere di test', siteErr.message); return report(); }

  const { data: worker, error: workerErr } = await supabase.from('workers').insert({
    company_id: COMPANY_ID, full_name: 'TEST-E2E Presence Closure', fiscal_code: `TSTPRC${Date.now()}`.slice(0, 16).toUpperCase(),
    is_active: true, badge_code: `TSTPRC${Date.now()}`,
  }).select('id').single();
  if (workerErr) { fail('crea lavoratore di test', workerErr.message); await cleanup(site.id, null); return report(); }

  const cleanDate = '2026-01-15'; // giorno "pulito", non oggi — evita collisioni con badge reali
  await supabase.from('presence_logs').insert([
    { company_id: COMPANY_ID, site_id: site.id, worker_id: worker.id, event_type: 'ENTRY', timestamp_server: `${cleanDate}T08:00:00+01:00`, method: 'scan' },
    { company_id: COMPANY_ID, site_id: site.id, worker_id: worker.id, event_type: 'EXIT',  timestamp_server: `${cleanDate}T17:00:00+01:00`, method: 'scan' },
  ]);

  try {
    // 1. Chiusura pulita
    const r1 = await closeDay(jwt, site.id, cleanDate);
    if (r1.status === 200 && r1.body?.resultCard?.contato) ok('giornata pulita si chiude con successo e produce una ResultCard');
    else fail('giornata pulita si chiude con successo e produce una ResultCard', r1);

    // 2. Richiusura rifiutata
    const r2 = await closeDay(jwt, site.id, cleanDate);
    if (r2.status === 409 && r2.body?.error === 'ALREADY_CLOSED') ok('richiudere la stessa giornata viene rifiutato (non sovrascritto)');
    else fail('richiudere la stessa giornata viene rifiutato (non sovrascritto)', r2);

    // 3. Giornata con anomalia (ENTRY senza EXIT)
    const anomalyDate = '2026-01-16';
    await supabase.from('presence_logs').insert([
      { company_id: COMPANY_ID, site_id: site.id, worker_id: worker.id, event_type: 'ENTRY', timestamp_server: `${anomalyDate}T08:00:00+01:00`, method: 'scan' },
    ]);
    const r3 = await closeDay(jwt, site.id, anomalyDate);
    if (r3.status === 400 && r3.body?.error === 'ANOMALIES_UNRESOLVED') ok('giornata con turno aperto (anomalia) viene rifiutata — riverifica reale, non un lock burocratico');
    else fail('giornata con turno aperto (anomalia) viene rifiutata', r3);
  } finally {
    await cleanup(site.id, worker.id);
  }

  report();
}

async function cleanup(siteId, workerId) {
  if (siteId) {
    await supabase.from('presence_day_closures').delete().eq('site_id', siteId);
    await supabase.from('presence_logs').delete().eq('site_id', siteId);
    await supabase.from('sites').delete().eq('id', siteId);
  }
  if (workerId) await supabase.from('workers').delete().eq('id', workerId);
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_presence_closure:', e.message);
  process.exit(1);
});
