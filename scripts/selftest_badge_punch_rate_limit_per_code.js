#!/usr/bin/env node
/**
 * scripts/selftest_badge_punch_rate_limit_per_code.js
 *
 * Regressione per F-145 (AUDIT.md): GET /api/v1/badge/:code/punch-context e
 * POST /api/v1/badge/:code/punch riusavano publicScanLimiter — chiave SOLO
 * IP, 30 richieste/min. Su un cantiere reale più lavoratori dietro la stessa
 * WiFi/NAT condividono lo stesso IP pubblico: una squadra che timbra insieme
 * all'inizio turno poteva esaurire il budget e bloccare timbrature legittime
 * di ALTRI lavoratori, non di un aggressore.
 *
 * Fix: nuovo badgePunchLimiter (middleware/rateLimit.js) con chiave
 * IP+badge_code — ogni lavoratore ha il proprio budget indipendente.
 *
 * Verifica dal vivo (chiamate HTTP reali, stesso IP client per tutte, due
 * badge_code distinti — esattamente lo scenario "due lavoratori sulla stessa
 * WiFi di cantiere"): saturare il budget del lavoratore A con richieste
 * ripetute non deve MAI bloccare una richiesta del lavoratore B.
 *
 * Env: TEST_BASE_URL (default produzione), SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta. Crea una company
 * di test isolata e autosufficiente (stesso pattern di
 * selftest_badge_geofence_and_compliance_visibility.js), non serve alcuna
 * fixture CI preesistente.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function newBadgeCode() { return crypto.randomBytes(9).toString('hex').toUpperCase(); }

async function main() {
  console.log('\nPalladia regression — rate limit timbratura per badge_code, non per IP (F-145)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('rate limit badge punch per-codice', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company, error: cErr } = await admin.from('companies')
    .insert([{ name: 'TEST-F145-RateLimitPerCode' }]).select('id').single();
  check('company di test isolata creata', !cErr && !!company, cErr);
  const companyId = company.id;

  const codeA = newBadgeCode();
  const codeB = newBadgeCode();
  const { data: workerA, error: errA } = await admin.from('workers').insert({
    company_id: companyId, full_name: 'TEST-F145-WorkerA', fiscal_code: `F145A${Date.now()}`.slice(0, 16).toUpperCase(), badge_code: codeA,
  }).select('id').single();
  const { data: workerB, error: errB } = await admin.from('workers').insert({
    company_id: companyId, full_name: 'TEST-F145-WorkerB', fiscal_code: `F145B${Date.now()}`.slice(0, 16).toUpperCase(), badge_code: codeB,
  }).select('id').single();
  check('due lavoratori di test seminati con badge_code distinti', !errA && !errB && !!workerA && !!workerB, { errA, errB });

  try {
    // Il nuovo limiter permette 20 richieste/min per (IP, badge_code). Ne
    // mandiamo 25 per il lavoratore A dallo stesso IP di questo processo —
    // deve arrivare almeno un 429 per A (il limite esiste ed è rispettato).
    let sawRateLimitOnA = false;
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${BASE}/api/v1/badge/${codeA}/punch-context`);
      if (res.status === 429) { sawRateLimitOnA = true; break; }
    }
    check('il budget del lavoratore A si esaurisce davvero (limite presente e attivo)', sawRateLimitOnA);

    // Subito dopo aver saturato A dallo stesso IP, B (badge_code diverso,
    // stesso IP) deve ancora rispondere 200 — è il cuore del fix: A e B non
    // condividono più lo stesso contatore solo perché condividono l'IP.
    const resB = await fetch(`${BASE}/api/v1/badge/${codeB}/punch-context`);
    const bodyB = await resB.json().catch(() => ({}));
    check(
      'il lavoratore B (stesso IP, badge_code diverso) NON è bloccato dal budget esaurito di A',
      resB.status === 200,
      { status: resB.status, body: bodyB }
    );
  } finally {
    await admin.from('workers').delete().in('id', [workerA?.id, workerB?.id].filter(Boolean));
    await admin.from('companies').delete().eq('id', companyId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
