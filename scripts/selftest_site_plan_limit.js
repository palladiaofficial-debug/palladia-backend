#!/usr/bin/env node
/**
 * scripts/selftest_site_plan_limit.js
 *
 * Regressione per il limite di cantieri attivi per piano (AUDIT.md, gruppo D
 * del freeze pre-lancio — "Limiti piano: da testare manualmente"). Verifica
 * dal vivo, con una chiamata HTTP reale (non lettura di codice), che il
 * piano Starter (limite 5, services/stripe.js PLAN_LIMITS) blocchi davvero
 * la creazione di un sesto cantiere attivo con 403 SITE_LIMIT_REACHED e un
 * messaggio in italiano comprensibile.
 *
 * Non richiede Stripe: il piano è letto da companies.subscription_plan,
 * indipendente dal flusso di pagamento reale — nessun rischio di addebito.
 *
 * Env: TEST_BASE_URL (default http://localhost:3001), SUPABASE_URL,
 * SUPABASE_ANON_KEY/SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY, E2E_EMAIL,
 * E2E_PASSWORD, E2E_COMPANY_ID. Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const E2E_EMAIL = process.env.E2E_EMAIL;
const E2E_PASSWORD = process.env.E2E_PASSWORD;
const E2E_COMPANY_ID = process.env.E2E_COMPANY_ID;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — limite cantieri attivi per piano (Starter = 5)\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !E2E_EMAIL || !E2E_PASSWORD || !E2E_COMPANY_ID) {
    skip('limite piano cantieri', 'fixture E2E non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies').select('subscription_plan, subscription_status, trial_ends_at').eq('id', E2E_COMPANY_ID).maybeSingle();
  check('Company E2E in piano Starter (limite atteso: 5)', company?.subscription_plan === 'starter', company);

  const { data: existing } = await admin.from('sites').select('id').eq('company_id', E2E_COMPANY_ID).in('status', ['attivo', 'sospeso']);
  check('Nessun cantiere attivo residuo prima del test (evita falsi negativi)', (existing || []).length === 0, existing);

  const { data: session, error: loginErr } = await anon.auth.signInWithPassword({ email: E2E_EMAIL, password: E2E_PASSWORD });
  check('Login E2E riuscito', !loginErr && session?.session, loginErr);
  const jwt = session?.session?.access_token;

  const seededIds = [];
  try {
    // Seed diretto in DB dei primi 5 (fino al limite) — solo l'ultimo, il
    // sesto, deve passare per l'endpoint reale per verificare il blocco.
    for (let i = 1; i <= 5; i++) {
      const { data: site, error } = await admin.from('sites').insert({
        company_id: E2E_COMPANY_ID, name: `TEST-E2E-LimitePiano-${i}-${Date.now()}`,
        address: 'Via Test 1, Genova', status: 'attivo',
      }).select('id').single();
      if (error) throw new Error(`seed sito ${i} fallito: ${error.message}`);
      seededIds.push(site.id);
    }
    ok('Seminati 5 cantieri attivi (limite Starter) via DB');

    const res = await fetch(`${BASE}/api/v1/sites`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': E2E_COMPANY_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `TEST-E2E-LimitePiano-6-${Date.now()}`, address: 'Via Test 1, Genova' }),
    });
    const body = await res.json().catch(() => ({}));
    check('Il 6° cantiere viene rifiutato con 403 SITE_LIMIT_REACHED', res.status === 403 && body.error === 'SITE_LIMIT_REACHED', { status: res.status, body });
    check('Messaggio in italiano, non un errore grezzo', typeof body.message === 'string' && /piano|cantieri/i.test(body.message), body.message);

    if (res.status !== 403) {
      const created = body?.id || body?.site?.id;
      if (created) seededIds.push(created);
    }
  } finally {
    if (seededIds.length) await admin.from('sites').delete().in('id', seededIds);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
