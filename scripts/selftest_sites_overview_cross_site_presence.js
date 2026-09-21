#!/usr/bin/env node
/**
 * scripts/selftest_sites_overview_cross_site_presence.js
 *
 * F-221 (AUDIT.md): GET /api/v1/sites/overview calcolava le "presenze live"
 * (liveCount/onSiteNames) indicizzando l'ultimo log del giorno per la coppia
 * (site_id, worker_id), invece che per il solo worker_id come fa il resto
 * della codebase dopo F-172 (routes/v1/presenceCorrections.js::open-sessions,
 * dashboard.js, chat.js, alerts.js, ladiaActions.js, i due cron missingExit*).
 *
 * Un lavoratore che entra in un cantiere A e poi esce (o viene corretto in
 * uscita) da un cantiere B diverso, senza mai timbrare l'uscita ad A, restava
 * "in corso" per sempre nel cruscotto cantieri di A — anche se globalmente
 * il suo ultimo evento della giornata è un'uscita.
 *
 * Chiama l'endpoint reale via HTTP (richiede il server in ascolto, come
 * selftest_presence_closure.js) contro due cantieri/un lavoratore di test
 * creati via DB.
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

async function getOverview(jwt) {
  const res = await fetch(`${BASE}/api/v1/sites/overview`, {
    headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': COMPANY_ID },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.log('\x1b[33mSKIP\x1b[0m selftest_sites_overview_cross_site_presence: E2E_EMAIL/E2E_PASSWORD non configurati.');
    return;
  }
  console.log('\n\x1b[1mGET /sites/overview — presenza live cross-cantiere (F-221)\x1b[0m');

  const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
  const { data: sess, error: authErr } = await auth.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (authErr) { fail('login bot E2E', authErr.message); return report(); }
  const jwt = sess.session.access_token;

  const { data: siteA, error: siteAErr } = await supabase.from('sites').insert({
    company_id: COMPANY_ID, name: 'TEST-E2E-cross-site-A', status: 'attivo', address: 'Via Test A, Genova',
  }).select('id').single();
  if (siteAErr) { fail('crea cantiere A di test', siteAErr.message); return report(); }

  const { data: siteB, error: siteBErr } = await supabase.from('sites').insert({
    company_id: COMPANY_ID, name: 'TEST-E2E-cross-site-B', status: 'attivo', address: 'Via Test B, Genova',
  }).select('id').single();
  if (siteBErr) { fail('crea cantiere B di test', siteBErr.message); await cleanup(siteA.id, null, null); return report(); }

  const { data: worker, error: workerErr } = await supabase.from('workers').insert({
    company_id: COMPANY_ID, full_name: 'TEST-E2E Cross Site Presence', fiscal_code: `TSTCSP${Date.now()}`.slice(0, 16).toUpperCase(),
    is_active: true, badge_code: `TSTCSP${Date.now()}`,
  }).select('id').single();
  if (workerErr) { fail('crea lavoratore di test', workerErr.message); await cleanup(siteA.id, siteB.id, null); return report(); }

  await supabase.from('worksite_workers').insert([
    { company_id: COMPANY_ID, site_id: siteA.id, worker_id: worker.id, status: 'active' },
  ]);

  // Entrata reale a A tre ore fa, "uscita" (correzione manuale) a B un'ora fa — stesso giorno,
  // esattamente lo scenario Festim: mai timbrata l'uscita da A prima di spostarsi a B.
  const now = Date.now();
  const entryTs = new Date(now - 3 * 3_600_000).toISOString();
  const exitTs  = new Date(now - 1 * 3_600_000).toISOString();
  await supabase.from('presence_logs').insert([
    { company_id: COMPANY_ID, site_id: siteA.id, worker_id: worker.id, event_type: 'ENTRY', timestamp_server: entryTs, method: 'worker_self_punch' },
    { company_id: COMPANY_ID, site_id: siteB.id, worker_id: worker.id, event_type: 'EXIT',  timestamp_server: exitTs,  method: 'admin_manual_correction' },
  ]);

  try {
    const { status, body } = await getOverview(jwt);
    if (status !== 200) { fail('GET /sites/overview risponde 200', { status, body }); return; }

    const overviewA = (body || []).find(s => s.id === siteA.id);
    const overviewB = (body || []).find(s => s.id === siteB.id);

    if (!overviewA) fail('cantiere A presente nella risposta', body);
    else if (overviewA.liveCount === 0 && !(overviewA.onSiteNames || []).includes('TEST-E2E Cross Site Presence')) {
      ok('cantiere A NON mostra il lavoratore come "in corso" (ultimo evento globale è un\'uscita, anche se altrove)');
    } else {
      fail('cantiere A NON mostra il lavoratore come "in corso"', { liveCount: overviewA.liveCount, onSiteNames: overviewA.onSiteNames });
    }

    if (!overviewB) fail('cantiere B presente nella risposta', body);
    else if (overviewB.liveCount === 0) ok('cantiere B non mostra presenze (l\'ultimo log lì è un\'uscita senza entrata)');
    else fail('cantiere B non mostra presenze', { liveCount: overviewB.liveCount, onSiteNames: overviewB.onSiteNames });
  } finally {
    await cleanup(siteA.id, siteB.id, worker.id);
  }

  report();
}

async function cleanup(siteAId, siteBId, workerId) {
  if (siteAId) {
    await supabase.from('presence_logs').delete().eq('site_id', siteAId);
    await supabase.from('worksite_workers').delete().eq('site_id', siteAId);
    await supabase.from('sites').delete().eq('id', siteAId);
  }
  if (siteBId) {
    await supabase.from('presence_logs').delete().eq('site_id', siteBId);
    await supabase.from('worksite_workers').delete().eq('site_id', siteBId);
    await supabase.from('sites').delete().eq('id', siteBId);
  }
  if (workerId) await supabase.from('workers').delete().eq('id', workerId);
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_sites_overview_cross_site_presence:', e.message);
  process.exit(1);
});
