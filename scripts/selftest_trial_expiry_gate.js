#!/usr/bin/env node
/**
 * scripts/selftest_trial_expiry_gate.js
 *
 * BLOCCO 4 (Parte A, tempo) — verifica dal vivo la transizione "trial attivo
 * → trial scaduto" e il suo effetto reale: lib/billing.js:isBillingActive()
 * (logica pura) E middleware/verifyJwt.js:enforceBillingForWrites() (wiring
 * reale — una chiamata HTTP vera con JWT reale contro il server reale).
 *
 * Nessun evento Stripe coinvolto (subscription_status/trial_ends_at sono
 * colonne dirette su `companies`, non richiedono la chiave live) — coerente
 * col vincolo di sessione "solo code review su Stripe".
 */
'use strict';
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { isBillingActive } = require('../lib/billing');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const BACKEND_URL  = process.env.SELFTEST_BACKEND_URL || 'https://palladia-backend-production.up.railway.app';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }
function daysFromNow(n) { return new Date(Date.now() + n * 86400000).toISOString(); }

async function main() {
  console.log('\nPalladia regression — cancello trial (BLOCCO 4)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('trial expiry gate', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const suffix = Date.now();
  let companyId = null, userId = null;

  try {
    const { data: company } = await admin.from('companies')
      .insert({ name: `TEST-TrialGate-${suffix}`, subscription_status: 'trial', trial_ends_at: daysAgo(1) })
      .select('id').single();
    companyId = company?.id;
    check('Company di test creata (trial scaduto ieri)', !!companyId, company);

    // ═══ 1) Logica pura isBillingActive() — 3 scenari, tutti contro DB reale ═══
    check('trial scaduto (ieri) → isBillingActive = false', await isBillingActive(companyId) === false);

    await admin.from('companies').update({ trial_ends_at: daysFromNow(10) }).eq('id', companyId);
    check('trial non scaduto (+10gg) → isBillingActive = true', await isBillingActive(companyId) === true);

    await admin.from('companies').update({ subscription_status: 'active', trial_ends_at: daysAgo(200) }).eq('id', companyId);
    check('subscription_status=active (trial_ends_at irrilevante) → isBillingActive = true', await isBillingActive(companyId) === true);

    await admin.from('companies').update({ subscription_status: 'canceled' }).eq('id', companyId);
    check('subscription_status=canceled → isBillingActive = false', await isBillingActive(companyId) === false);

    // ═══ 2) Wiring reale: chiamata HTTP vera con trial scaduto → 402 ═══
    if (!ANON_KEY) {
      skip('verifica HTTP reale del gate', 'ANON_KEY non disponibile in questo ambiente');
    } else {
      const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
      const { data: userData, error: userErr } = await admin.auth.admin.createUser({
        email: `trial-gate-test-${suffix}@palladia-test.local`, email_confirm: true, password: `Test-${suffix}-Aa1!`,
      });
      check('Utente di test creato', !userErr && !!userData?.user?.id, userErr);
      userId = userData?.user?.id;

      await admin.from('company_users').insert({ company_id: companyId, user_id: userId, role: 'owner' });
      await admin.from('companies').update({ subscription_status: 'trial', trial_ends_at: daysAgo(1) }).eq('id', companyId);

      const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: userData.user.email });
      check('Magic link generato (nessuna email reale inviata: generateLink non fa il dispatch)', !linkErr && !!link, linkErr);
      const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
      const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
      check('Sessione reale ottenuta', !verErr && !!verified?.session?.access_token, verErr);
      const accessToken = verified?.session?.access_token;

      if (accessToken) {
        const writeRes = await fetch(`${BACKEND_URL}/api/v1/sites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, 'X-Company-Id': companyId },
          body: JSON.stringify({ name: 'Cantiere test trial scaduto' }),
        });
        check('Scrittura reale (POST /sites) con trial scaduto → 402 SUBSCRIPTION_REQUIRED', writeRes.status === 402, { status: writeRes.status, body: await writeRes.json().catch(() => null) });

        const readRes = await fetch(`${BACKEND_URL}/api/v1/sites`, {
          headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Company-Id': companyId },
        });
        check('Lettura reale (GET /sites) con trial scaduto → sempre permessa (200)', readRes.status === 200, readRes.status);

        // Riattiva → la stessa identica scrittura ora deve passare
        await admin.from('companies').update({ subscription_status: 'active' }).eq('id', companyId);
        const writeRes2 = await fetch(`${BACKEND_URL}/api/v1/sites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, 'X-Company-Id': companyId },
          body: JSON.stringify({ name: 'Cantiere test dopo riattivazione' }),
        });
        const writeBody2 = await writeRes2.json().catch(() => null);
        check('Stessa scrittura dopo riattivazione (subscription_status=active) → passa (201/200)', [200, 201].includes(writeRes2.status), { status: writeRes2.status, body: writeBody2 });
        if (writeBody2?.id) await admin.from('sites').delete().eq('id', writeBody2.id);
      }
    }
  } finally {
    if (companyId) await admin.from('company_users').delete().eq('company_id', companyId);
    if (companyId) await admin.from('sites').delete().eq('company_id', companyId);
    if (companyId) await admin.from('companies').delete().eq('id', companyId);
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
