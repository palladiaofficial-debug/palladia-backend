#!/usr/bin/env node
/**
 * scripts/selftest_stripe_webhook_handlers.js
 *
 * Regressione per F-059 (AUDIT.md): `invoice.payment_failed` e `account.updated`
 * erano scritti in server.js ma mai eseguiti in produzione — l'endpoint webhook
 * Stripe non li aveva tra gli enabled_events. Corretto lato Stripe (config
 * esterna, non testabile qui) — questo test copre la logica dei due handler,
 * ora estratta in lib/stripeWebhookHandlers.js, così un domani un refactor non
 * possa rompere la logica senza che npm test se ne accorga.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { handlePaymentFailed, handleAccountUpdated } = require('../lib/stripeWebhookHandlers');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got, null, 2).slice(0, 500)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\n=== selftest_stripe_webhook_handlers ===\n');

  // ── invoice.payment_failed ──────────────────────────────────────────────────
  const { data: company, error: companyErr } = await supabase.from('companies').insert({
    name: 'TEST-Stripe-Webhook-Handlers-Probe',
    stripe_customer_id: 'cus_test_f059_probe',
    subscription_status: 'active',
  }).select().single();
  check('Creata azienda temporanea con abbonamento active', !companyErr && company, companyErr);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }

  try {
    const result = await handlePaymentFailed({ customer: 'cus_test_f059_probe' });
    check('handlePaymentFailed: segnala updated:true per un customer noto', result.updated === true, result);
    check('handlePaymentFailed: ritorna il companyId corretto', result.companyId === company.id, result);

    const { data: afterFail } = await supabase.from('companies').select('subscription_status').eq('id', company.id).single();
    check('handlePaymentFailed: subscription_status diventa past_due', afterFail.subscription_status === 'past_due', afterFail);

    const unknown = await handlePaymentFailed({ customer: 'cus_does_not_exist_f059' });
    check('handlePaymentFailed: customer sconosciuto → updated:false, nessun crash', unknown.updated === false && unknown.reason === 'company_not_found', unknown);

    // Guardia anti-regressione esplicita per il bug reale di F-059: un evento
    // ricevuto ma con subscription_status già past_due non deve fare nulla di
    // strano (idempotenza — Stripe può ritentare la consegna).
    const idempotent = await handlePaymentFailed({ customer: 'cus_test_f059_probe' });
    check('handlePaymentFailed: idempotente su un secondo evento identico', idempotent.updated === true && idempotent.companyId === company.id, idempotent);
  } finally {
    await supabase.from('companies').delete().eq('id', company.id);
  }

  // ── account.updated (Stripe Connect) ────────────────────────────────────────
  const fakeUserId = '00000000-0000-4000-8000-000000000f59';
  const { data: profile, error: profileErr } = await supabase.from('consultant_profiles').insert({
    user_id: fakeUserId,
    stripe_account_id: 'acct_test_f059_probe',
    stripe_onboarding_complete: false,
    stripe_charges_enabled: false,
    stripe_payouts_enabled: false,
  }).select().single();
  check('Creato profilo consulente temporaneo con Connect non completato', !profileErr && profile, profileErr);
  if (!profile) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = failed > 0 ? 1 : 0; return; }

  try {
    const result = await handleAccountUpdated({
      id: 'acct_test_f059_probe',
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: false, // onboarding completo ma payout non ancora abilitati — caso reale intermedio
    });
    check('handleAccountUpdated: segnala updated:true per un account noto', result.updated === true, result);
    check('handleAccountUpdated: ritorna il profileId corretto', result.profileId === profile.id, result);

    const { data: afterUpdate } = await supabase.from('consultant_profiles')
      .select('stripe_onboarding_complete, stripe_charges_enabled, stripe_payouts_enabled')
      .eq('id', profile.id).single();
    check('handleAccountUpdated: stripe_onboarding_complete aggiornato', afterUpdate.stripe_onboarding_complete === true, afterUpdate);
    check('handleAccountUpdated: stripe_charges_enabled aggiornato', afterUpdate.stripe_charges_enabled === true, afterUpdate);
    check('handleAccountUpdated: stripe_payouts_enabled riflette il valore reale (false)', afterUpdate.stripe_payouts_enabled === false, afterUpdate);

    const unknown = await handleAccountUpdated({ id: 'acct_does_not_exist_f059', details_submitted: true, charges_enabled: true, payouts_enabled: true });
    check('handleAccountUpdated: account sconosciuto → updated:false, nessun crash', unknown.updated === false && unknown.profileId === null, unknown);
  } finally {
    await supabase.from('consultant_profiles').delete().eq('id', profile.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
