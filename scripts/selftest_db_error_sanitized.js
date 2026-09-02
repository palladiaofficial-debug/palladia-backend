#!/usr/bin/env node
/**
 * scripts/selftest_db_error_sanitized.js
 *
 * Regressione per F-089 (AUDIT.md, BLOCCO 5): 81 route handler in 14 file
 * rispondevano a un errore Postgres/PostgREST con
 * `res.status(500).json({ error: error.message })` — il messaggio grezzo del
 * database (sintassi SQL, nomi di colonne/vincoli) arrivava intatto al
 * client. Riprodotto dal vivo con GET /workers/:workerId e un id non-UUID:
 * prima del fix rispondeva `{"error":"invalid input syntax for type uuid: \"...\""}`.
 * Fix: lib/httpErrors.js (sendDbError) centralizza la risposta con un
 * messaggio comprensibile, mentre il dettaglio reale resta visibile per il
 * team via Sentry. Stesso trattamento applicato al gestore d'errore globale
 * di server.js per i 5xx propagati via next(err).
 *
 * Stesso fixture di selftest_workers_export_route_order.js:
 * ci-test@palladia.internal / MSCedilizia. Env: TEST_BASE_URL (default
 * http://localhost:3001), SUPABASE_URL, SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY.
 * Se mancano o l'utente/company di test non esistono, il test si salta.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { sendDbError } = require('../lib/httpErrors');

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

function fakeRes() {
  return {
    _status: null, _body: null,
    status(s) { this._status = s; return this; },
    json(b) { this._body = b; return this; },
  };
}

async function main() {
  console.log('\nPalladia regression — errori DB grezzi sanificati verso il client (F-089)\n');

  // 1) Unit test del punto di svolta condiviso — sempre eseguito, nessuna rete.
  const r1 = fakeRes();
  sendDbError(r1, { message: 'duplicate key value violates unique constraint "workers_fiscal_code_key"' });
  check('sendDbError() default a status 500', r1._status === 500, r1._status);
  check('sendDbError() non include mai il messaggio Postgres grezzo', !JSON.stringify(r1._body).includes('constraint'), r1._body);
  check('sendDbError() produce un messaggio non vuoto', typeof r1._body.error === 'string' && r1._body.error.length > 10, r1._body);

  const r2 = fakeRes();
  sendDbError(r2, new Error('boom'), 400);
  check('sendDbError() rispetta lo status esplicito (400)', r2._status === 400, r2._status);

  // 2) Verifica dal vivo: stesso endpoint/scenario che ha rivelato il bug.
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    skip('GET /workers/:workerId con id malformato', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find((u) => u.email === TEST_EMAIL);
  if (!user) {
    skip('GET /workers/:workerId con id malformato', `utente ${TEST_EMAIL} non trovato in questo ambiente`);
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = failed > 0 ? 1 : 0;
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

  const res = await fetch(`${BASE}/api/v1/workers/not-a-valid-uuid`, {
    headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
  });
  const body = await res.json().catch(() => ({}));
  check('GET /workers/<id-malformato> resta un 5xx', res.status >= 500, { status: res.status });
  check('La risposta NON contiene il messaggio Postgres grezzo', !JSON.stringify(body).toLowerCase().includes('invalid input syntax'), body);
  check('La risposta contiene un messaggio comprensibile', typeof body.error === 'string' && body.error.length > 15, body);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
