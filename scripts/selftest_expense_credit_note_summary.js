#!/usr/bin/env node
/**
 * scripts/selftest_expense_credit_note_summary.js
 *
 * Regressione per GET /api/v1/expenses/summary dopo l'introduzione di
 * is_credit_note (migrazione 165, canale fatture via email — note di credito TD04
 * e affini devono ridurre i costi, non sommarsi). Chiamata HTTP reale con JWT reale
 * (sessione via magic link, non reset password — vedi memoria di collaborazione),
 * non solo lettura del codice.
 *
 * Usa una data lontana nel futuro per isolare le due righe di test da qualunque
 * dato reale della company, evitando di dover azzerare/filtrare il resto.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_EMAIL = 'ci-test@palladia.internal';
const TEST_DATE = '2099-06-15'; // isolata da qualunque dato reale

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — note di credito in /expenses/summary\n');

  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    skip('note di credito in summary', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: users } = await admin.auth.admin.listUsers();
  const user = users?.users?.find((u) => u.email === TEST_EMAIL);
  if (!user) {
    skip('note di credito in summary', `utente ${TEST_EMAIL} non trovato in questo ambiente`);
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    return;
  }

  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', (memberships || []).map((m) => m.company_id));
  const company = (companies || []).find((c) => c.name === 'MSCedilizia');
  check('Company di test MSCedilizia trovata', !!company, companies);
  if (!company) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }
  const companyId = company.id;

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: TEST_EMAIL });
  check('Magic link generato', !linkErr && !!link, linkErr);
  const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
  const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  check('Sessione ottenuta via OTP (non reset password)', !verErr && !!verified?.session, verErr);
  const jwt = verified?.session?.access_token;
  if (!jwt) { console.log(`\n${passed} passati, ${failed} falliti\n`); process.exitCode = 1; return; }

  const rowsToClean = [];
  try {
    const { data: normal, error: normalErr } = await admin.from('company_expenses').insert({
      company_id: companyId, amount: 1000, description: 'TEST fattura normale', category: 'materiali',
      payment_method: 'bonifico', supplier: 'TEST Fornitore CN', expense_date: TEST_DATE,
      is_deductible: true, source: 'manual', is_credit_note: false,
    }).select().single();
    check('Riga normale creata', !normalErr && !!normal, normalErr);
    if (normal) rowsToClean.push(normal.id);

    const { data: credit, error: creditErr } = await admin.from('company_expenses').insert({
      company_id: companyId, amount: 200, description: 'TEST nota di credito', category: 'materiali',
      payment_method: 'bonifico', supplier: 'TEST Fornitore CN', expense_date: TEST_DATE,
      is_deductible: true, source: 'email', is_credit_note: true, sdi_document_type: 'TD04',
    }).select().single();
    check('Riga nota di credito creata (amount positivo, is_credit_note true)', !creditErr && !!credit && Number(credit.amount) === 200, creditErr);
    if (credit) rowsToClean.push(credit.id);

    const res = await fetch(`${BASE}/api/v1/expenses/summary?from=${TEST_DATE}&to=${TEST_DATE}`, {
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
    });
    check('GET /expenses/summary risponde 200', res.status === 200, res.status);
    const summary = await res.json();

    check('Totale netto = 1000 - 200 = 800 (nota di credito sottratta, non sommata)', summary.total === 800, summary);
    check('Totale per categoria "materiali" netto = 800', summary.by_category?.materiali?.total === 800, summary.by_category);
    check('Conteggio righe invariato a 2 (la nota di credito resta una riga reale, solo il segno cambia in aggregazione)', summary.by_category?.materiali?.count === 2, summary.by_category);
  } finally {
    if (rowsToClean.length) await admin.from('company_expenses').delete().in('id', rowsToClean);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err.message);
  process.exitCode = 1;
});
