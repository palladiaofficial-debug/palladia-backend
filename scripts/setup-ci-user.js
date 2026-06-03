#!/usr/bin/env node
/**
 * scripts/setup-ci-user.js
 *
 * Crea un utente CI dedicato in Supabase, lo aggiunge alla prima company come admin,
 * e stampa le variabili da impostare su Railway.
 *
 * Eseguire UNA SOLA VOLTA:
 *   node scripts/setup-ci-user.js
 */
'use strict';
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY richiesti');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CI_EMAIL    = 'ci-test@palladia.internal';
const CI_PASSWORD = 'CiPalladia2026!!' + Math.random().toString(36).slice(2, 8);

async function main() {
  console.log('\n=== Setup CI Test User ===\n');

  // 1. Trova o crea utente CI
  let userId;
  const { data: existingUsers } = await supabase.auth.admin.listUsers();
  const existing = existingUsers?.users?.find(u => u.email === CI_EMAIL);

  if (existing) {
    console.log(`Utente CI già esistente: ${CI_EMAIL}`);
    userId = existing.id;
    // Aggiorna la password
    await supabase.auth.admin.updateUserById(userId, { password: CI_PASSWORD });
    console.log('Password aggiornata.');
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email: CI_EMAIL,
      password: CI_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'CI Test User' },
    });
    if (error) { console.error('Errore creazione utente:', error.message); process.exit(1); }
    userId = data.user.id;
    console.log(`Utente CI creato: ${CI_EMAIL} (id: ${userId})`);
  }

  // 2. Trova prima company disponibile
  const { data: companies, error: compErr } = await supabase
    .from('companies')
    .select('id, name')
    .limit(1)
    .single();
  if (compErr || !companies) { console.error('Nessuna company trovata:', compErr?.message); process.exit(1); }
  const companyId = companies.id;
  console.log(`Company trovata: ${companies.name} (${companyId})`);

  // 3. Aggiungi utente CI alla company come admin (se non già presente)
  const { data: existing_member } = await supabase
    .from('company_users')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!existing_member) {
    const { error: insertErr } = await supabase
      .from('company_users')
      .insert({ company_id: companyId, user_id: userId, role: 'admin' });
    if (insertErr) { console.error('Errore aggiunta a company:', insertErr.message); process.exit(1); }
    console.log('Utente CI aggiunto alla company come admin.');
  } else {
    console.log('Utente CI già membro della company.');
  }

  // 4. Trova un cantiere e un lavoratore di test
  const { data: site } = await supabase
    .from('sites')
    .select('id, name')
    .eq('company_id', companyId)
    .neq('status', 'eliminato')
    .limit(1)
    .maybeSingle();

  const { data: worker } = await supabase
    .from('workers')
    .select('id, full_name')
    .eq('company_id', companyId)
    .limit(1)
    .maybeSingle();

  // 5. Firma in per ottenere JWT
  const anonClient = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY || SERVICE_KEY);
  const { data: session, error: signInErr } = await anonClient.auth.signInWithPassword({
    email: CI_EMAIL,
    password: CI_PASSWORD,
  });
  if (signInErr) { console.error('Errore login CI:', signInErr.message); process.exit(1); }
  const jwt = session.session.access_token;

  // 6. Stampa risultato
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Variabili da aggiungere su Railway (Settings → Variables)');
  console.log('══════════════════════════════════════════════════════\n');
  console.log(`TEST_CI_EMAIL    = ${CI_EMAIL}`);
  console.log(`TEST_CI_PASSWORD = ${CI_PASSWORD}`);
  console.log(`TEST_COMPANY_ID  = ${companyId}`);
  console.log(`TEST_SITE_ID     = ${site?.id || '(nessun cantiere trovato)'}`);
  console.log(`TEST_WORKER_ID   = ${worker?.id || '(nessun lavoratore trovato)'}`);
  console.log('\n(TEST_JWT non serve più — il test script fa login in automatico)\n');

  if (!site) console.warn('⚠ Nessun cantiere trovato. TEST_SITE_ID non impostabile.');
  if (!worker) console.warn('⚠ Nessun lavoratore trovato. TEST_WORKER_ID non impostabile.');
}

main().catch(e => { console.error('Errore:', e.message); process.exit(1); });
