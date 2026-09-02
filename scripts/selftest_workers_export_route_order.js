#!/usr/bin/env node
/**
 * scripts/selftest_workers_export_route_order.js
 *
 * Regressione per F-084 (AUDIT.md, repo frontend): GET /api/v1/workers/export
 * veniva sempre intercettato dalla route generica GET /workers/:workerId
 * (registrata prima in routes/v1/workers.js), che tentava di leggere la
 * stringa letterale "export" come UUID — 500 con errore Postgres grezzo in
 * chiaro, stesso pattern di F-082. Trovato dal fuzzer esplorativo di Livello 2
 * cliccando il bottone di export su /risorse.
 *
 * Verifica dal vivo con una chiamata HTTP reale, JWT reale.
 *
 * Stesso pattern fixture di selftest_company_profile_empty_email.js:
 * ci-test@palladia.internal / MSCedilizia. Env: TEST_BASE_URL (default
 * http://localhost:3001), SUPABASE_URL, SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY.
 * Se mancano o l'utente/company di test non esistono, il test si salta.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_EMAIL = 'ci-test@palladia.internal';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — GET /workers/export intercettata da /workers/:workerId (F-084)\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    skip('workers/export route order', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find((u) => u.email === TEST_EMAIL);
  if (!user) {
    skip('workers/export route order', `utente ${TEST_EMAIL} non trovato in questo ambiente`);
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const companyIds = (memberships || []).map((m) => m.company_id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', companyIds);
  const company = (companies || []).find((c) => c.name === 'MSCedilizia');
  check('Company di test MSCedilizia trovata', !!company, companies);
  const companyId = company?.id;

  const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
  const { data: session, error: loginErr } = await anon.auth.signInWithPassword({ email: TEST_EMAIL, password: tempPassword });
  check('Login ci-test riuscito', !loginErr && !!session?.session, loginErr);
  const jwt = session?.session?.access_token;

  const res = await fetch(`${BASE}/api/v1/workers/export`, {
    headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
  });
  check('GET /workers/export non torna 500 "invalid input syntax for type uuid"', res.status !== 500, { status: res.status });
  check('GET /workers/export torna 200 con un file XLSX reale', res.status === 200 && (res.headers.get('content-type') || '').includes('spreadsheet'), { status: res.status, contentType: res.headers.get('content-type') });

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
