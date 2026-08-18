#!/usr/bin/env node
/**
 * scripts/selftest_billing_renewal_notice.js
 *
 * Regressione per F-058 (AUDIT.md): nessun avviso prima del rinnovo Stripe —
 * l'utente ha scoperto un addebito live di 29€ guardando l'app della banca,
 * senza nessuna email di preavviso.
 *
 * Copre lib/billingRenewalNotice.js:
 * 1) buildRenewalNoticeData() — pura, su fixture invoice.upcoming realistiche
 *    (con/senza next_payment_attempt, con/senza descrizione riga).
 * 2) findCompanyByStripeCustomer() + getCompanyAdminEmails() — contro DB reale,
 *    con una company/utente temporanei creati e ripuliti da questo test.
 *
 * Deliberatamente NON testato qui (stessa scelta di selftest_ai_spend_circuit_breaker.js):
 * l'invio reale via Resend — invocherebbe davvero l'email ad ogni run di
 * `npm test`. Verificato una volta dal vivo con un evento webhook firmato
 * reale contro l'endpoint di produzione (vedi AUDIT.md F-058).
 */
'use strict';
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { buildRenewalNoticeData, findCompanyByStripeCustomer, getCompanyAdminEmails } = require('../lib/billingRenewalNotice');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — avviso rinnovo abbonamento (F-058)\n');

  // ── 1) buildRenewalNoticeData — pura, nessun I/O ──────────────────────────
  const full = buildRenewalNoticeData({
    amount_due: 2900,
    currency: 'eur',
    next_payment_attempt: 1755512400, // 2025-08-18T09:00:00Z circa
    period_end: 1755500000,
    lines: { data: [{ description: '1 × Palladia Starter (a €29.00/month)' }] },
  });
  check('importo convertito da centesimi (2900 → 29.00)', full.amount === 29, full.amount);
  check('currency normalizzata maiuscola', full.currency === 'EUR', full.currency);
  check('renewalDate usa next_payment_attempt quando presente', full.renewalDate === new Date(1755512400 * 1000).toISOString(), full.renewalDate);
  check('planName preso dalla descrizione della riga fattura', full.planName === '1 × Palladia Starter (a €29.00/month)', full.planName);

  const fallback = buildRenewalNoticeData({
    amount_due: 5900,
    currency: 'eur',
    period_end: 1755500000,
    lines: { data: [] },
  });
  check('renewalDate ricade su period_end se manca next_payment_attempt', fallback.renewalDate === new Date(1755500000 * 1000).toISOString(), fallback.renewalDate);
  check('planName ricade su default se la riga fattura non ha descrizione', fallback.planName === 'abbonamento Palladia', fallback.planName);

  const empty = buildRenewalNoticeData({ currency: 'eur', lines: { data: [] } });
  check('nessun crash su invoice minimale (amount_due/date assenti)', empty.amount === 0 && empty.renewalDate === null, empty);

  // ── 2) Risoluzione company + admin email contro DB reale ─────────────────
  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('findCompanyByStripeCustomer / getCompanyAdminEmails', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const fakeCustomerId = `cus_TEST_${Date.now()}`;
  let tempCompanyId = null;
  let tempUserId = null;

  try {
    const { data: company, error: companyErr } = await admin
      .from('companies')
      .insert({ name: `TEST-RenewalNotice-${Date.now()}`, subscription_plan: 'starter', stripe_customer_id: fakeCustomerId })
      .select('id, name')
      .single();
    check('Creata azienda temporanea con stripe_customer_id', !companyErr && !!company?.id, companyErr);
    tempCompanyId = company?.id;

    const notFound = await findCompanyByStripeCustomer('cus_NON_ESISTE_MAI');
    check('findCompanyByStripeCustomer(customer inesistente) → null', notFound === null, notFound);

    const found = await findCompanyByStripeCustomer(fakeCustomerId);
    check('findCompanyByStripeCustomer() trova la company giusta dal customer id', found?.id === tempCompanyId, found);

    const testEmail = `renewal-notice-test-${Date.now()}@palladia-test.local`;
    const { data: userData, error: userErr } = await admin.auth.admin.createUser({
      email: testEmail, email_confirm: true, password: `Test-${Date.now()}-Aa1!`,
    });
    check('Creato utente owner temporaneo', !userErr && !!userData?.user?.id, userErr);
    tempUserId = userData?.user?.id;

    const { error: cuErr } = await admin.from('company_users').insert({
      company_id: tempCompanyId, user_id: tempUserId, role: 'owner',
    });
    check('Collegato utente alla company come owner', !cuErr, cuErr);

    const emails = await getCompanyAdminEmails(tempCompanyId);
    check('getCompanyAdminEmails() ritorna l\'email dell\'owner', emails.includes(testEmail), emails);

    const emailsEmptyCompany = await getCompanyAdminEmails('00000000-0000-0000-0000-000000000000');
    check('getCompanyAdminEmails(company senza utenti) → array vuoto, nessun crash', Array.isArray(emailsEmptyCompany) && emailsEmptyCompany.length === 0, emailsEmptyCompany);
  } finally {
    if (tempCompanyId) await admin.from('company_users').delete().eq('company_id', tempCompanyId);
    if (tempCompanyId) await admin.from('companies').delete().eq('id', tempCompanyId);
    if (tempUserId) await admin.auth.admin.deleteUser(tempUserId).catch(() => {});
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
