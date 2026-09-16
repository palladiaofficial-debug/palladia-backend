#!/usr/bin/env node
/**
 * scripts/selftest_payer_access_pin_login.js
 *
 * Regressione per il "sistema pagamenti" (migrazione 214, AUDIT.md): lista
 * buste paga condivisa con chi fa i bonifici (spesso uno studio esterno, non
 * un utente Palladia), con PIN a 6 cifre come l'area lavoratore (F-102) e la
 * possibilità di segnare una busta come pagata sia dal link esterno sia da
 * Palladia.
 *
 * Verifica dal vivo, HTTP reale contro produzione (Railway), stesso schema
 * di selftest_worker_area_pin_login.js:
 * 1) prima di generare l'accesso, il login è rifiutato (PIN_NOT_SET).
 * 2) l'azienda genera l'accesso (JWT) — access_code + PIN in chiaro UNA
 *    volta sola.
 * 3) PIN sbagliato rifiutato, PIN giusto dà un token valido.
 * 4) col token si vede davvero la busta paga di test (worker_name risolto).
 * 5) "segna pagata" dal link esterno scrive davvero payment_status='pagata'
 *    in DB (non solo la risposta HTTP).
 * 6) l'azienda vede lo stesso stato aggiornato da Palladia (GET /payslips/shared).
 * 7) l'azienda può segnare pagata/da pagare anche dal suo lato (JWT).
 * 8) rigenerare l'accesso invalida il PIN precedente.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY/SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * E2E_EMAIL, E2E_PASSWORD, E2E_COMPANY_ID — stessi fixture permanenti di
 * selftest_worker_area_pin_login.js. Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const supabase = require('../lib/supabase');

const API_BASE = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const E2E_EMAIL = process.env.E2E_EMAIL;
const E2E_PASSWORD = process.env.E2E_PASSWORD;
const E2E_COMPANY_ID = process.env.E2E_COMPANY_ID;
const BUCKET = 'site-documents';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function signIn(email, password) {
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Login fallito per ${email}: ${error.message}`);
  return data.session.access_token;
}

async function main() {
  console.log('\n=== Sistema pagamenti buste paga: accesso PIN esterno + segna pagata (migrazione 214) ===\n');

  if (!SUPABASE_URL || !ANON_KEY || !E2E_EMAIL || !E2E_PASSWORD || !E2E_COMPANY_ID) {
    skip('payer access suite', 'fixture E2E (E2E_EMAIL/E2E_PASSWORD/E2E_COMPANY_ID) non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const jwt = await signIn(E2E_EMAIL, E2E_PASSWORD);
  const authHeaders = { Authorization: `Bearer ${jwt}`, 'X-Company-Id': E2E_COMPANY_ID, 'Content-Type': 'application/json' };

  const badgeCode = crypto.randomBytes(9).toString('hex').toUpperCase();
  const { data: worker, error: wErr } = await supabase
    .from('workers')
    .insert({ company_id: E2E_COMPANY_ID, full_name: 'TEST-E2E Payments Worker', badge_code: badgeCode, is_active: true })
    .select('id').single();
  if (wErr || !worker) { console.error('Impossibile creare il worker di test:', wErr?.message); process.exit(1); }

  const storagePath = `payslips/${E2E_COMPANY_ID}/${worker.id}/2026-05.pdf`;
  await supabase.storage.from(BUCKET).upload(storagePath, Buffer.from('%PDF-1.4 test'), { contentType: 'application/pdf' });
  const { data: payslip, error: pErr } = await supabase
    .from('payslips')
    .insert({
      company_id: E2E_COMPANY_ID, worker_id: worker.id, period_year: 2026, period_month: 5,
      filename: 'test-payments.pdf', file_path: storagePath, file_size: 20,
      status: 'shared', shared_at: new Date().toISOString(),
    })
    .select('id').single();
  if (pErr || !payslip) { console.error('Impossibile creare la busta paga di test:', pErr?.message); await supabase.from('workers').delete().eq('id', worker.id); process.exit(1); }

  try {
    // ── prima di generare l'accesso, nessun accesso esiste ──────────────────
    const beforeGetRes = await fetch(`${API_BASE}/payslips/payer-access`, { headers: authHeaders });
    const beforeGetBody = await beforeGetRes.json();
    check('prima della generazione, /payer-access risulta vuoto', beforeGetRes.status === 200 && beforeGetBody === null, beforeGetBody);

    // ── genera l'accesso (JWT, company-scoped) ───────────────────────────────
    const genRes = await fetch(`${API_BASE}/payslips/payer-access`, { method: 'POST', headers: authHeaders });
    const genBody = await genRes.json();
    check('generazione accesso riesce, ritorna access_code + PIN a 6 cifre',
      genRes.status === 200 && !!genBody.access_code && /^\d{6}$/.test(genBody.pin || ''), genBody);
    const { access_code: accessCode, pin } = genBody;

    // ── login rifiutato con PIN sbagliato ────────────────────────────────────
    const wrongPin = pin === '111111' ? '222222' : '111111';
    const wrongRes = await fetch(`${API_BASE}/payer/${accessCode}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: wrongPin }),
    });
    check('login con PIN sbagliato viene rifiutato (401)', wrongRes.status === 401, wrongRes.status);

    // ── login col PIN vero funziona ──────────────────────────────────────────
    const rightRes = await fetch(`${API_BASE}/payer/${accessCode}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
    });
    const rightBody = await rightRes.json();
    check('login col PIN vero riesce e ritorna un token', rightRes.status === 200 && !!rightBody.token, rightBody);
    const payerToken = rightBody.token;

    // ── col token si vede davvero la busta di test, con nome lavoratore ─────
    const listRes = await fetch(`${API_BASE}/payer/${accessCode}/payslips`, { headers: { Authorization: `PayerArea ${payerToken}` } });
    const listBody = await listRes.json();
    const found = Array.isArray(listBody) ? listBody.find(r => r.id === payslip.id) : null;
    check('la busta di test compare nella lista con nome lavoratore risolto e payment_status iniziale "da_pagare"',
      !!found && found.worker_name === 'TEST-E2E Payments Worker' && found.payment_status === 'da_pagare', found);

    // ── "segna pagata" dal link esterno scrive davvero in DB ────────────────
    const markPaidRes = await fetch(`${API_BASE}/payer/${accessCode}/payslips/${payslip.id}/mark-paid`, {
      method: 'POST', headers: { Authorization: `PayerArea ${payerToken}` },
    });
    check('mark-paid dal link esterno risponde ok', markPaidRes.status === 200, markPaidRes.status);

    const { data: rowAfterPaid } = await supabase.from('payslips').select('payment_status, paid_at, paid_by').eq('id', payslip.id).single();
    check('lo stato REALE in DB è "pagata", paid_by="payer", paid_at valorizzato (non solo la risposta 200)',
      rowAfterPaid?.payment_status === 'pagata' && rowAfterPaid?.paid_by === 'payer' && !!rowAfterPaid?.paid_at, rowAfterPaid);

    // ── l'azienda vede lo stesso stato da Palladia ───────────────────────────
    const sharedRes = await fetch(`${API_BASE}/payslips/shared`, { headers: authHeaders });
    const sharedBody = await sharedRes.json();
    const sharedRow = Array.isArray(sharedBody) ? sharedBody.find(r => r.id === payslip.id) : null;
    check('GET /payslips/shared (lato azienda) mostra la stessa busta già segnata pagata',
      sharedRow?.payment_status === 'pagata', sharedRow);

    // ── l'azienda può segnare "da pagare" dal suo lato ───────────────────────
    const unpaidRes = await fetch(`${API_BASE}/payslips/${payslip.id}/mark-unpaid`, { method: 'PATCH', headers: authHeaders });
    check('mark-unpaid lato azienda risponde ok', unpaidRes.status === 200, unpaidRes.status);
    const { data: rowAfterUnpaid } = await supabase.from('payslips').select('payment_status, paid_at, paid_by').eq('id', payslip.id).single();
    check('lo stato REALE in DB torna "da_pagare", paid_at/paid_by azzerati',
      rowAfterUnpaid?.payment_status === 'da_pagare' && !rowAfterUnpaid?.paid_at && !rowAfterUnpaid?.paid_by, rowAfterUnpaid);

    // ── rigenerare l'accesso invalida il PIN precedente ──────────────────────
    const regenRes = await fetch(`${API_BASE}/payslips/payer-access`, { method: 'POST', headers: authHeaders });
    const regenBody = await regenRes.json();
    const oldPinRes = await fetch(`${API_BASE}/payer/${accessCode}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
    });
    check('rigenerare l\'accesso invalida subito il PIN precedente (stesso access_code)',
      regenRes.status === 200 && regenBody.access_code === accessCode && oldPinRes.status === 401,
      { regenStatus: regenRes.status, sameCode: regenBody.access_code === accessCode, oldPinStatus: oldPinRes.status });
  } finally {
    await supabase.from('payslips').delete().eq('id', payslip.id);
    await supabase.storage.from(BUCKET).remove([storagePath]).catch(() => {});
    await supabase.from('workers').delete().eq('id', worker.id);
    await supabase.from('company_payer_access').delete().eq('company_id', E2E_COMPANY_ID);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Errore fatale:', e); process.exit(1); });
