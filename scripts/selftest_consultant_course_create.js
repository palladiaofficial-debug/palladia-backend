#!/usr/bin/env node
/**
 * scripts/selftest_consultant_course_create.js
 *
 * Regressione per il bug "/consulente/corsi — il salvataggio non completa
 * mai" (AUDIT.md, gruppo D del freeze pre-lancio). Causa reale: lo schema
 * Zod POST /api/v1/consultant/courses richiede `issuing_body_name` e un
 * `course_type_id` valido, ma il frontend non aveva alcun campo per il
 * primo e permetteva l'invio col secondo vuoto (null) — ogni submit
 * falliva sempre con 400 VALIDATION_ERROR. Fix lato frontend in
 * ConsulenteCorsi.tsx (nuovo campo "Ente erogatore *", validazione
 * client-side su entrambi). Questo test verifica il contratto backend con
 * chiamate HTTP reali, non letture di codice.
 *
 * Env: TEST_BASE_URL (default http://localhost:3001), SUPABASE_URL,
 * SUPABASE_ANON_KEY/SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * E2E_CONSULENTE_EMAIL, E2E_CONSULENTE_PASSWORD. Se mancano, il test si
 * salta — non è una regressione, è un ambiente senza le credenziali di test.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const E2E_CONSULENTE_EMAIL = process.env.E2E_CONSULENTE_EMAIL;
const E2E_CONSULENTE_PASSWORD = process.env.E2E_CONSULENTE_PASSWORD;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — /consulente/corsi creazione corso (issuing_body_name mancante)\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !E2E_CONSULENTE_EMAIL || !E2E_CONSULENTE_PASSWORD) {
    skip('creazione corso consulente', 'fixture E2E consulente non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: session, error: loginErr } = await anon.auth.signInWithPassword({ email: E2E_CONSULENTE_EMAIL, password: E2E_CONSULENTE_PASSWORD });
  check('Login E2E consulente riuscito', !loginErr && session?.session, loginErr);
  const jwt = session?.session?.access_token;
  if (!jwt) {
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }

  const { data: courseType } = await admin.from('course_types').select('id').limit(1).maybeSingle();
  check('Trovato un course_type reale su cui testare', !!courseType, courseType);

  // ── Payload esattamente come lo inviava il vecchio frontend (bug) ──
  const brokenBody = {
    title: 'TEST-E2E corso rotto', description: null, price_cents: 10000, duration_hours: 8,
    delivery_mode: 'presenza', location_city: null, location_address: null, max_participants: 20,
    course_type_id: null, is_draft: true, sessions: [],
  };
  const brokenRes = await fetch(`${BASE}/api/v1/consultant/courses`, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(brokenBody),
  });
  check('Payload del vecchio frontend (senza issuing_body_name) viene rifiutato con 400, non appeso', brokenRes.status === 400, { status: brokenRes.status });

  // ── Payload come lo invia oggi il frontend corretto ──
  const goodBody = {
    title: 'TEST-E2E corso valido', description: null, price_cents: 10000, duration_hours: 8,
    delivery_mode: 'presenza', location_city: null, location_address: null, max_participants: 20,
    issuing_body_name: 'TEST-E2E Ente erogatore', course_type_id: courseType?.id, is_draft: true, sessions: [],
  };
  const goodRes = await fetch(`${BASE}/api/v1/consultant/courses`, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(goodBody),
  });
  const goodBodyResp = await goodRes.json().catch(() => ({}));
  check('Payload corretto (con issuing_body_name + course_type_id) crea il corso davvero', goodRes.status === 200 || goodRes.status === 201, { status: goodRes.status, body: goodBodyResp });

  const createdId = goodBodyResp?.course?.id || goodBodyResp?.id;
  if (createdId) {
    const { data: row } = await admin.from('marketplace_courses').select('id, issuing_body_name').eq('id', createdId).maybeSingle();
    check('Il corso esiste davvero nella tabella storica con issuing_body_name salvato', row?.issuing_body_name === 'TEST-E2E Ente erogatore', row);
    await admin.from('marketplace_courses').delete().eq('id', createdId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
