#!/usr/bin/env node
/**
 * scripts/selftest_expense_receipt_upload.js
 *
 * Regressione per F-083 (AUDIT.md, repo frontend): POST /api/v1/expenses/:id/receipt
 * caricava sempre su un bucket Supabase Storage inesistente ('company-docs' —
 * ogni altra route documenti era già stata consolidata su 'site-documents',
 * questo file era rimasto indietro). Risultato: allegare uno scontrino/fattura
 * a una spesa falliva SEMPRE con 500 STORAGE_ERROR "Bucket not found", per
 * qualunque azienda.
 *
 * Verifica dal vivo con una chiamata HTTP reale (file PDF vero allegato via
 * multipart), JWT reale, e una query DB diretta dopo l'upload — non solo lo
 * status HTTP della risposta.
 *
 * Stesso pattern fixture di selftest_company_profile_empty_email.js:
 * ci-test@palladia.internal / MSCedilizia. Env: TEST_BASE_URL (default
 * http://localhost:3001), SUPABASE_URL, SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY.
 * Se mancano o l'utente/company di test non esistono, il test si salta.
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_EMAIL = 'ci-test@palladia.internal';
const DEMO_PDF = path.join(__dirname, '_demo_scontrino_test.pdf');

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — Upload ricevuta spesa su bucket inesistente (F-083)\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !fs.existsSync(DEMO_PDF)) {
    skip('upload ricevuta spesa', 'fixture Supabase o PDF demo non disponibili in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: users } = await admin.auth.admin.listUsers();
  const user = users?.users?.find((u) => u.email === TEST_EMAIL);
  if (!user) {
    skip('upload ricevuta spesa', `utente ${TEST_EMAIL} non trovato in questo ambiente`);
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

  const { data: expense, error: expErr } = await admin.from('company_expenses').insert({
    company_id: companyId, amount: 12.34, description: 'F-083 regressione ricevuta', category: 'materiali', payment_method: 'contanti', expense_date: '2026-08-20', source: 'manual',
  }).select('id, receipt_url').single();
  check('Spesa throwaway creata', !expErr && !!expense, expErr);

  try {
    const buf = fs.readFileSync(DEMO_PDF);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'application/pdf' }), 'scontrino.pdf');

    const res = await fetch(`${BASE}/api/v1/expenses/${expense.id}/receipt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    check('Upload ricevuta va a buon fine (200), non 500 STORAGE_ERROR "Bucket not found"', res.status === 200, { status: res.status, body });
    check('La risposta include un receipt_signed_url reale', typeof body.receipt_signed_url === 'string' && body.receipt_signed_url.startsWith('http'), body);

    const { data: after, error: afterErr } = await admin.from('company_expenses').select('receipt_url').eq('id', expense.id).single();
    check('Query diretta DB, non solo status HTTP: receipt_url è stato scritto davvero', !afterErr && !!after?.receipt_url, { afterErr, after });

    if (after?.receipt_url) {
      const { data: listed } = await admin.storage.from('site-documents').list(path.dirname(after.receipt_url));
      const found = (listed || []).some(f => after.receipt_url.endsWith(f.name));
      check('Il file esiste davvero nel bucket site-documents (non solo il riferimento in DB)', found, listed);
      await admin.storage.from('site-documents').remove([after.receipt_url]).catch(() => {});
    }
  } finally {
    if (expense?.id) await admin.from('company_expenses').delete().eq('id', expense.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
