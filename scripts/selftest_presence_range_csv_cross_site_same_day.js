#!/usr/bin/env node
/**
 * scripts/selftest_presence_range_csv_cross_site_same_day.js
 *
 * F-222 (AUDIT.md): GET /api/v1/reports/presence-range (export CSV "Dati
 * grezzi", usato dalla pagina Presenze & Report in modalità "tutti i
 * cantieri") raggruppava i log per (worker, cantiere) PRIMA di accoppiare
 * ENTRY/EXIT, presumendo che un cambio cantiere chiuda SEMPRE l'ENTRY
 * precedente con un'uscita automatica (method auto_exit_on_site_change).
 * Falso quando l'uscita è una correzione manuale dell'admin su un cantiere
 * diverso da quello dell'entrata — caso reale: Festim Dervishaj, entrata a
 * Via San Nazaro 34, uscita corretta a Via Riboli 4b. Stesso fix gemello di
 * services/workerHoursReport.js (vedi
 * selftest_worker_hours_report_cross_site_same_day.js) e
 * routes/v1/sitesOverview.js (F-221).
 *
 * Chiama l'endpoint reale via HTTP (richiede il server in ascolto, come
 * selftest_sites_overview_cross_site_presence.js) contro due cantieri/un
 * lavoratore di test creati via DB.
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
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }

async function getCsv(jwt, from, to) {
  const res = await fetch(`${BASE}/api/v1/reports/presence-range?from=${from}&to=${to}`, {
    headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': COMPANY_ID },
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.log('\x1b[33mSKIP\x1b[0m selftest_presence_range_csv_cross_site_same_day: E2E_EMAIL/E2E_PASSWORD non configurati.');
    return;
  }
  console.log('\n\x1b[1mGET /reports/presence-range — cambio cantiere stesso giorno senza uscita auto (F-222)\x1b[0m');

  const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
  const { data: sess, error: authErr } = await auth.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (authErr) { fail('login bot E2E', authErr.message); return report(); }
  const jwt = sess.session.access_token;

  const { data: siteA, error: siteAErr } = await supabase.from('sites').insert({
    company_id: COMPANY_ID, name: 'TEST-E2E-F222-SanNazaro', status: 'attivo', address: 'Via Test A, Genova',
  }).select('id').single();
  if (siteAErr) { fail('crea cantiere A di test', siteAErr.message); return report(); }

  const { data: siteB, error: siteBErr } = await supabase.from('sites').insert({
    company_id: COMPANY_ID, name: 'TEST-E2E-F222-Riboli', status: 'attivo', address: 'Via Test B, Genova',
  }).select('id').single();
  if (siteBErr) { fail('crea cantiere B di test', siteBErr.message); await cleanup(siteA.id, null, null); return report(); }

  const { data: worker, error: workerErr } = await supabase.from('workers').insert({
    company_id: COMPANY_ID, full_name: 'TEST-E2E F222 CrossSite', fiscal_code: `TSTF222${Date.now()}`.slice(0, 16).toUpperCase(),
    is_active: true, badge_code: `TSTF222${Date.now()}`,
  }).select('id').single();
  if (workerErr) { fail('crea lavoratore di test', workerErr.message); await cleanup(siteA.id, siteB.id, null); return report(); }

  const date = '2026-06-15';
  await supabase.from('presence_logs').insert([
    { company_id: COMPANY_ID, site_id: siteA.id, worker_id: worker.id, event_type: 'ENTRY', timestamp_server: `${date}T07:52:00+02:00`, method: 'worker_self_punch' },
    { company_id: COMPANY_ID, site_id: siteB.id, worker_id: worker.id, event_type: 'EXIT',  timestamp_server: `${date}T17:00:00+02:00`, method: 'admin_manual_correction' },
  ]);

  try {
    const { status, text } = await getCsv(jwt, date, date);
    if (status !== 200) { fail('GET /reports/presence-range risponde 200', { status, text: text.slice(0, 200) }); return; }

    const lines = text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
    const workerLines = lines.filter(l => l.includes('TEST-E2E F222 CrossSite'));

    if (workerLines.length === 1) ok('UNA sola riga per il lavoratore (non due: entrata orfana + uscita orfana separate)');
    else fail('UNA sola riga per il lavoratore', workerLines);

    const row = workerLines[0] || '';
    if (row && !/Uscita mancante/.test(row) && !/Uscita senza entrata/.test(row)) {
      ok('nessuna anomalia "Uscita mancante"/"Uscita senza entrata" (giornata riconosciuta come continua)');
    } else {
      fail('nessuna anomalia "Uscita mancante"/"Uscita senza entrata"', row);
    }

    if (/Cantiere cambiato/.test(row)) ok('anomalia segnala il cambio di cantiere, non lo nasconde');
    else fail('anomalia segnala il cambio di cantiere', row);

    // 07:52->17:00 grezzi 9h08m, pausa pranzo automatica 60min dedotta -> 8.13h netti
    if (/,8\.13,/.test(row)) ok('ore totali corrette (9h08m grezzi - 60min pausa pranzo = 8.13h netti)');
    else fail('ore totali corrette (atteso 8.13h netti)', row);
  } finally {
    await cleanup(siteA.id, siteB.id, worker.id);
  }

  report();
}

async function cleanup(siteAId, siteBId, workerId) {
  if (siteAId) {
    await supabase.from('presence_logs').delete().eq('site_id', siteAId);
    await supabase.from('sites').delete().eq('id', siteAId);
  }
  if (siteBId) {
    await supabase.from('presence_logs').delete().eq('site_id', siteBId);
    await supabase.from('sites').delete().eq('id', siteBId);
  }
  if (workerId) await supabase.from('workers').delete().eq('id', workerId);
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_presence_range_csv_cross_site_same_day:', e.message);
  process.exit(1);
});
