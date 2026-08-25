#!/usr/bin/env node
/**
 * scripts/selftest_site_address_optional.js
 *
 * Regressione per F-082 (AUDIT.md): POST /api/v1/sites falliva sempre con un
 * errore Postgres grezzo ("null value in column \"address\" ... violates
 * not-null constraint") quando il campo indirizzo era omesso — esattamente
 * il caso che WelcomeWizard.tsx (onboarding) etichetta "Indirizzo
 * (opzionale)" e non blocca in invio. Riprodotto dal vivo contro produzione
 * (gate di lancio, giorno 6) creando un cantiere via chiamata reale con
 * `address` del tutto assente dal body — 500 confermato prima del fix.
 *
 * Self-contained: crea un utente e una company throwaway via service role,
 * nessuna fixture E2E preesistente richiesta. Env: TEST_BASE_URL (default
 * http://localhost:3001, come gli altri selftest — passare l'URL di
 * produzione esplicitamente per una verifica dal vivo contro il deploy
 * reale), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY,
 * SUPABASE_ANON_KEY/SUPABASE_KEY. Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — F-082: POST /sites senza indirizzo (onboarding "opzionale")\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('F-082 sites senza address', 'variabili Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const email = `selftest.f082.${Date.now()}@palladia-test.local`;
  const password = 'F082' + Math.random().toString(36).slice(2, 10) + '!9';
  const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  check('Utente throwaway creato', !createErr && created?.user, createErr);
  if (createErr) { console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 1; return; }

  const { data: session, error: loginErr } = await anon.auth.signInWithPassword({ email, password });
  check('Login riuscito', !loginErr && session?.session, loginErr);
  const jwt = session?.session?.access_token;
  if (!jwt) { console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 1; return; }

  const onbRes = await fetch(`${BASE}/api/v1/onboarding/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ company_name: 'TEST-F082-SiteAddress', full_name: 'F082 Tester', account_type: 'impresa' }),
  });
  const onbBody = await onbRes.json();
  check('Company throwaway onboardata', onbRes.status === 201, { status: onbRes.status, onbBody });
  const companyId = onbBody.company_id;

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId };

  // Caso F-082: address del tutto assente dal body (non solo stringa vuota) —
  // esattamente quello che manda WelcomeWizard.tsx quando l'utente lo salta.
  const res = await fetch(`${BASE}/api/v1/sites`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: 'TEST-F082-Cantiere-SenzaIndirizzo' }),
  });
  const body = await res.json();
  check('POST /sites senza address → 201, non più 500 Postgres grezzo', res.status === 201, { status: res.status, body });
  check('address salvato come stringa vuota, non null/assente', body.address === '', body.address);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
