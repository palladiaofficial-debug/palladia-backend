#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_route_auth_cascade_latency.js
 *
 * Regressione per F-100 (AUDIT.md) — quasi ogni endpoint /api/v1/* impiegava
 * 4-8 secondi anche per query banali su tabelle piccole (es. GET
 * /prezzario/regioni, 131 righe, tempo diretto a Supabase 300-1400ms).
 *
 * Causa: ~15 file sotto routes/v1/ montano `router.use(verifySupabaseJwt)`
 * SENZA scoping di path (es. archive.js, companyDocuments.js, economia.js,
 * notifications.js...). Siccome tutti questi router sono montati con
 * `router.use('/', require(...))` sullo stesso path base in routes/v1/index.js,
 * Express esegue il middleware di OGNI router mano a mano che scorre la
 * catena — anche quando nessuna rotta di quel router corrisponde alla
 * richiesta. Ogni verifySupabaseJwt fa una chiamata di rete a getUser() +
 * una query a company_users (~200ms ciascuna): per un endpoint montato dopo
 * ~14 di questi router "a guardia cieca", la richiesta si autentica 14 volte
 * di troppo prima di raggiungere la rotta vera — 14 × ~400ms ≈ 5-6s,
 * combaciando esattamente con la lentezza osservata (screenshot utente:
 * pagina Prezzario bloccata su skeleton/spinner).
 *
 * Isolato aggiungendo timer diagnostici temporanei (rimossi in questo stesso
 * commit) che hanno mostrato "getUser+company_users+query business" sommare
 * a ~600ms mentre curl misurava 5.76s totali — il resto era tutto middleware
 * a monte mai eseguito per la rotta giusta.
 *
 * Fix: gli stessi router.use(verifySupabaseJwt) diventano
 * router.use(<prefix di questo file>, verifySupabaseJwt) — esattamente il
 * pattern già usato correttamente da smartImport.js, formazioneAdmin.js e
 * certificates.js in questo stesso repo. Comportamento di autenticazione
 * identico sulle rotte vere, ma saltato per ogni richiesta che non è sua.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const API_BASE = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';

// Soglia generosa: la latenza sana osservata (auth + query reale) è
// 400-1000ms. 2500ms lascia ampio margine per jitter di rete/Supabase senza
// nascondere una regressione della cascata di auth (che produce 4-8s).
const THRESHOLD_MS = 2500;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }

async function sessionFor(admin, anon, email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr) throw linkErr;
  const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
  const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  if (verErr) throw verErr;
  return verified.session.access_token;
}

async function timedGet(path, token, companyId) {
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Company-Id': companyId },
  });
  const elapsed = Date.now() - t0;
  return { status: res.status, elapsed };
}

async function main() {
  console.log('\nPalladia — F-100: cascata di auth ridondante sulle route /api/v1/* (regressione)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const anon  = createClient(SUPABASE_URL, ANON_KEY);

  const TEST_EMAIL = 'ci-test@palladia.internal';
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const user = (users?.users || []).find(u => u.email === TEST_EMAIL);
  if (!user) { skip('suite', `utente ${TEST_EMAIL} non trovato`); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 0; return; }

  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const companyIds = (memberships || []).map(m => m.company_id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', companyIds);
  const msc = (companies || []).find(c => c.name === 'MSCedilizia');
  if (!msc) { skip('suite', 'company MSCedilizia non trovata per ci-test'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 0; return; }

  let token;
  try { token = await sessionFor(admin, anon, TEST_EMAIL); }
  catch (e) { skip('suite', 'sessione JWT non ottenuta: ' + e.message); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); process.exitCode = 0; return; }

  // Endpoint montati tardi nella catena di routes/v1/index.js — dietro molti
  // router.use(verifySupabaseJwt) non-scoped prima del fix. Un "riscaldamento"
  // (chiamata scartata) evita di misurare il cold-start della connessione.
  const ROUTES = [
    '/prezzario/regioni',
    '/company-prezzi?limit=5',
    '/notifications?limit=5',
    '/expenses/summary',
  ];

  for (const path of ROUTES) {
    await timedGet(path, token, msc.id); // warm-up, non misurato
    const { status, elapsed } = await timedGet(path, token, msc.id);
    if (status !== 200) {
      fail(`GET ${path} risponde 200`, { status, elapsed });
      continue;
    }
    const withinThreshold = elapsed < THRESHOLD_MS;
    if (withinThreshold) ok(`GET ${path} risponde entro ${THRESHOLD_MS}ms (${elapsed}ms)`);
    else fail(`GET ${path} risponde entro ${THRESHOLD_MS}ms`, `${elapsed}ms — sintomo esatto della cascata di re-autenticazione F-100`);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE FATALE:', e.message); process.exitCode = 1; });
