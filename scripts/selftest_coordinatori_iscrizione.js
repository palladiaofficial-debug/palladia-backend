#!/usr/bin/env node
/**
 * scripts/selftest_coordinatori_iscrizione.js — F-429 (AUDIT.md del frontend).
 *
 * L'iscrizione libera dei coordinatori, su aziende di prova vere (DB):
 *  - senza codice d'invito non serve nessun controllo: area coordinatori accesa, 30 giorni di prova;
 *  - con un codice d'invito valido: 60 giorni, come prima; un codice sbagliato si controlla ancora;
 *  - un'impresa non tocca niente di tutto questo;
 *  - il piano coordinatore è uno solo: il prezzo di 150 € l'anno (STRIPE_PRICE_COORDINATORE_150),
 *    e senza la variabile il pagamento lo dice invece di usare il vecchio prezzo;
 *  - la rotta di onboarding non rifiuta più un coordinatore senza codice.
 */
'use strict';
require('dotenv').config({ quiet: true });
const fs = require('fs');
const supabase = require('../lib/supabase');
const I = require('../lib/coordinatoriIscrizione');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const giorniDa = (iso) => Math.round((Date.parse(iso) - Date.now()) / 86400000);

(async () => {
  console.log('\n\x1b[1mF-429 — l\'iscrizione libera dei coordinatori\x1b[0m');
  const T = `TEST-F429-${Date.now()}`;
  const ins = async (t, r) => { const { data, error } = await supabase.from(t).insert(r).select().single(); if (error) throw new Error(`${t}: ${error.message}`); return data; };
  const libero = await ins('companies', { name: `${T} Studio Libero`, account_type: 'coordinatore' });
  const invitato = await ins('companies', { name: `${T} Studio Invitato`, account_type: 'coordinatore' });
  const codice = `CSE-${String(Date.now()).slice(-4)}-TEST`.replace(/[01]/g, '2');
  try {
    check('senza codice non si controlla niente', I.codiceDaControllare('coordinatore', '') === false && I.codiceDaControllare('coordinatore', null) === false);
    check('col codice del link d\'invito sì; un\'impresa mai', I.codiceDaControllare('coordinatore', 'CSE-AAAA-BBBB') === true && I.codiceDaControllare('impresa', 'CSE-AAAA-BBBB') === false);

    check('iscrizione libera: attivata', await I.attiva(libero.id, null) === true);
    const { data: f } = await supabase.from('company_feature_flags').select('enabled').eq('company_id', libero.id).eq('feature', 'psc_coordinatori').maybeSingle();
    const { data: c1 } = await supabase.from('companies').select('trial_ends_at').eq('id', libero.id).single();
    check('area coordinatori accesa e 30 giorni di prova', f?.enabled === true && Math.abs(giorniDa(c1.trial_ends_at) - 30) <= 1, { f, trial: c1.trial_ends_at });

    await ins('psc_beta_invites', { code: codice, note: T });
    check('col codice d\'invito: attivata', await I.attiva(invitato.id, codice) === true);
    const { data: c2 } = await supabase.from('companies').select('trial_ends_at').eq('id', invitato.id).single();
    check('…con i 60 giorni dell\'invito', Math.abs(giorniDa(c2.trial_ends_at) - 60) <= 1, c2.trial_ends_at);

    const vecchio = process.env.STRIPE_PRICE_COORDINATORE_150;
    const { getPriceId, PLAN_PRICES } = require('../services/stripe');
    process.env.STRIPE_PRICE_COORDINATORE_150 = 'price_test_150';
    check('il piano coordinatore usa il prezzo da 150 €', !!PLAN_PRICES?.coordinatore_150 && getPriceId('coordinatore_150') === 'price_test_150');
    delete process.env.STRIPE_PRICE_COORDINATORE_150;
    let senza = null;
    try { getPriceId('coordinatore_150'); } catch (e) { senza = e.message; }
    check('senza la variabile, il pagamento lo dice', /non configurata/.test(senza || ''), senza);
    if (vecchio) process.env.STRIPE_PRICE_COORDINATORE_150 = vecchio;

    const billing = fs.readFileSync(require('path').join(__dirname, '../routes/v1/billing.js'), 'utf8');
    check('la rotta del pagamento manda il coordinatore al prezzo da 150 €', /getPriceId\(plan === 'coordinatore' \? 'coordinatore_150' : plan\)/.test(billing));
    const onb = fs.readFileSync(require('path').join(__dirname, '../routes/v1/onboarding.js'), 'utf8');
    check('l\'onboarding non rifiuta più un coordinatore senza codice', /codiceDaControllare\(account_type, beta_code\)/.test(onb) && !/account_type === 'coordinatore' && !pscBeta\.openSignup\(\)/.test(onb));
  } finally {
    await supabase.from('psc_beta_invites').delete().eq('code', codice);
    for (const c of [libero, invitato]) {
      await supabase.from('company_feature_flags').delete().eq('company_id', c.id);
      await supabase.from('companies').delete().eq('id', c.id);
    }
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
