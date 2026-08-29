#!/usr/bin/env node
/**
 * scripts/selftest_worker_area_pin_login.js
 *
 * Regressione F-102 (AUDIT.md), parte 2 — il login all'area lavoratore
 * (buste paga/presenze) usava il codice fiscale come unico fattore. Il CF
 * non è mai stato un vero segreto (calcolabile da nome+data+luogo di
 * nascita, mostrati per forza sulla stessa pagina badge per la verifica
 * ispettore) — vedi selftest_badge_public_fiscal_code_exposure.js per la
 * fuga diretta già chiusa. Qui si verifica il rimpiazzo: un PIN numerico
 * generato dall'amministratore (POST /workers/:workerId/area-pin, JWT),
 * comunicato al lavoratore fuori banda, mai esposto da nessun endpoint
 * pubblico.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY/SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * E2E_EMAIL, E2E_PASSWORD, E2E_COMPANY_ID — stessi fixture permanenti usati
 * dalla suite Playwright frontend e da selftest_archive_actions_auth.js. Se
 * mancano, il test si salta (ambiente senza credenziali di test, non una
 * regressione).
 *
 * Uso: node scripts/selftest_worker_area_pin_login.js
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
  console.log('\n=== F-102 (parte 2): login area lavoratore col PIN, non più col CF ===\n');

  if (!SUPABASE_URL || !ANON_KEY || !E2E_EMAIL || !E2E_PASSWORD || !E2E_COMPANY_ID) {
    skip('worker area PIN login suite', 'fixture E2E (E2E_EMAIL/E2E_PASSWORD/E2E_COMPANY_ID) non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const jwt = await signIn(E2E_EMAIL, E2E_PASSWORD);

  const badgeCode = crypto.randomBytes(9).toString('hex').toUpperCase();
  const { data: worker, error: insErr } = await supabase
    .from('workers')
    .insert({ company_id: E2E_COMPANY_ID, full_name: 'TEST-E2E F102 Pin Login', badge_code: badgeCode, is_active: true })
    .select('id')
    .single();
  if (insErr || !worker) { console.error('Impossibile creare il worker di test:', insErr?.message); process.exit(1); }

  try {
    // Prima di generare un PIN, il login deve fallire con un errore chiaro (non 500, non "corretto per caso").
    const beforePinRes = await fetch(`${API_BASE}/area/${badgeCode}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '000000' }),
    });
    const beforePinBody = await beforePinRes.json();
    check('login prima di aver generato un PIN viene rifiutato con PIN_NOT_SET', beforePinRes.status === 401 && beforePinBody.error === 'PIN_NOT_SET', beforePinBody);

    // L'amministratore genera il PIN (endpoint autenticato, company-scoped).
    const genRes = await fetch(`${API_BASE}/workers/${worker.id}/area-pin`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': E2E_COMPANY_ID, 'Content-Type': 'application/json' },
    });
    const genBody = await genRes.json();
    check('generazione PIN riesce e ritorna 6 cifre', genRes.status === 200 && /^\d{6}$/.test(genBody.pin || ''), genBody);
    const pin = genBody.pin;

    // Il vecchio CF (anche indovinato per caso) non è più un formato accettato.
    const cfRes = await fetch(`${API_BASE}/area/${badgeCode}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cf: 'AAAAAA00A00A000A' }),
    });
    check('login con un vecchio-stile "cf" nel body viene rifiutato (400, formato non valido)', cfRes.status === 400, cfRes.status);

    // Un PIN sbagliato viene rifiutato.
    const wrongPin = pin === '111111' ? '222222' : '111111';
    const wrongRes = await fetch(`${API_BASE}/area/${badgeCode}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: wrongPin }),
    });
    check('login con PIN sbagliato viene rifiutato (401)', wrongRes.status === 401, wrongRes.status);

    // Il PIN vero funziona e dà accesso reale ai dati protetti.
    const rightRes = await fetch(`${API_BASE}/area/${badgeCode}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
    });
    const rightBody = await rightRes.json();
    check('login col PIN vero riesce e ritorna un token', rightRes.status === 200 && !!rightBody.token, rightBody);

    if (rightBody.token) {
      const payslipsRes = await fetch(`${API_BASE}/area/${badgeCode}/payslips`, {
        headers: { Authorization: `WorkerArea ${rightBody.token}` },
      });
      check('col token ottenuto dal PIN si accede davvero a /payslips', payslipsRes.status === 200, payslipsRes.status);
    }

    // Rigenerare il PIN invalida quello vecchio.
    const regenRes = await fetch(`${API_BASE}/workers/${worker.id}/area-pin`, {
      method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': E2E_COMPANY_ID, 'Content-Type': 'application/json' },
    });
    const regenBody = await regenRes.json();
    const oldPinRes = await fetch(`${API_BASE}/area/${badgeCode}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
    });
    check('rigenerare il PIN invalida subito quello precedente', regenRes.status === 200 && oldPinRes.status === 401, { regenStatus: regenRes.status, oldPinStatus: oldPinRes.status, samePin: regenBody.pin === pin });
  } finally {
    await supabase.from('workers').delete().eq('id', worker.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Errore fatale:', e); process.exit(1); });
