#!/usr/bin/env node
/**
 * scripts/selftest_rls_documenti.js
 *
 * Test di regressione per F-031 (AUDIT.md): worker_certificates, durc_records,
 * studio_shared_documents, studio_document_requests non avevano MAI RLS abilitato.
 *
 * Verifica dal vivo, non lettura di codice: crea un'azienda "estranea" temporanea
 * con un service-role client (bypassa RLS per definizione), inserisce una riga per
 * ognuna delle 4 tabelle, poi interroga le stesse righe con l'utente CI reale
 * (anon key + JWT, lo stesso percorso che userebbe un client legittimo) filtrando
 * esplicitamente su quel company_id. Senza RLS la riga è comunque visibile (nessuna
 * barriera a livello DB); con RLS attivo e is_company_member(company_id), l'utente
 * CI — che non è membro dell'azienda estranea — deve vedere zero righe.
 *
 * Env: stesse di selftest_api.js (SUPABASE_URL, SUPABASE_ANON_KEY/SUPABASE_KEY,
 * SUPABASE_SERVICE_ROLE_KEY, TEST_CI_EMAIL, TEST_CI_PASSWORD, TEST_COMPANY_ID).
 */
'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const ANON_KEY       = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CI_EMAIL        = process.env.TEST_CI_EMAIL    || 'ci-test@palladia.internal';
const CI_PASS         = process.env.TEST_CI_PASSWORD || '';
const OWN_COMPANY_ID  = process.env.TEST_COMPANY_ID  || 'd5dd4e79-635b-4ceb-ae74-9548a1dcfee1';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log(`\nPalladia RLS regression — documenti (F-031)\n`);

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('F-031 suite', 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }
  if (!ANON_KEY || !CI_PASS) {
    skip('F-031 suite', 'ANON key o TEST_CI_PASSWORD mancanti — serve un client autenticato non service-role');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // Login come utente CI con l'anon key — questo client rispetta RLS per davvero.
  const loginRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ email: CI_EMAIL, password: CI_PASS }),
  });
  const login = await loginRes.json();
  if (!login?.access_token) {
    skip('F-031 suite', `login CI fallito: ${login?.error_description || JSON.stringify(login)}`);
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }
  const asCiUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${login.access_token}` } },
  });
  ok('Login utente CI (client con RLS reale, non service-role)');

  // Azienda "estranea" temporanea — il CI user non ne è membro.
  const { data: foreignCompany, error: companyErr } = await admin
    .from('companies').insert({ name: 'TEST-RLS-Foreign-Probe' }).select().single();
  check('Creata azienda estranea temporanea', !companyErr && foreignCompany, companyErr);
  if (!foreignCompany) {
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 1;
    return;
  }
  const foreignId = foreignCompany.id;

  // Studio esistente riusato solo per soddisfare la FK NOT NULL — non viene modificato.
  const { data: someStudio } = await admin.from('studio_partners').select('id').limit(1).single();
  const studioId = someStudio?.id || null;

  const inserted = {};
  const tables = [
    { name: 'worker_certificates', row: { company_id: foreignId, worker_id: null, issue_date: '2024-01-01', expiry_date: '2099-01-01', issuing_body: 'TEST-RLS' } },
    { name: 'durc_records', row: studioId ? { company_id: foreignId, studio_id: studioId, issue_date: '2024-01-01', expiry_date: '2099-01-01' } : null },
    { name: 'studio_shared_documents', row: studioId ? { studio_id: studioId, company_id: foreignId, name: 'TEST-RLS doc', file_path: 'test-rls/probe.pdf' } : null },
    { name: 'studio_document_requests', row: studioId ? { studio_id: studioId, company_id: foreignId, title: 'TEST-RLS request' } : null },
  ];

  for (const t of tables) {
    if (!t.row) { skip(`Seed riga estranea in ${t.name}`, 'nessuno studio_partners esistente da riusare per la FK'); continue; }
    const { data, error } = await admin.from(t.name).insert(t.row).select().single();
    check(`Seed riga estranea in ${t.name}`, !error && data, error);
    if (data) inserted[t.name] = data.id;
  }

  // Il cuore del test: l'utente CI, filtrando esplicitamente su quell'azienda
  // estranea, deve vedere ZERO righe se RLS è attivo e scoped correttamente.
  for (const t of tables) {
    if (!inserted[t.name]) continue;
    const { data, error } = await asCiUser.from(t.name).select('id').eq('company_id', foreignId);
    check(
      `RLS blocca ${t.name}: utente CI non vede la riga di un'azienda estranea`,
      !error && Array.isArray(data) && data.length === 0,
      error || data
    );
  }

  // Sanity check positivo su una tabella: l'utente CI vede comunque le proprie righe.
  {
    const { data: ownRow, error: ownInsertErr } = await admin.from('worker_certificates')
      .insert({ company_id: OWN_COMPANY_ID, worker_id: null, issue_date: '2024-01-01', expiry_date: '2099-01-01', issuing_body: 'TEST-RLS-OWN' }).select().single();
    if (ownRow) {
      const { data, error } = await asCiUser.from('worker_certificates').select('id').eq('id', ownRow.id);
      check('RLS non blocca l\'accesso alle proprie righe (worker_certificates)', !error && data?.length === 1, error || data);
      await admin.from('worker_certificates').delete().eq('id', ownRow.id);
    } else {
      skip('Sanity check accesso proprie righe', ownInsertErr?.message || 'insert fallito');
    }
  }

  // Cleanup — esplicito per tabella prima di cancellare l'azienda (studio_document_requests
  // non ha ON DELETE CASCADE su company_id, quindi il delete company fallirebbe altrimenti).
  for (const t of tables) {
    if (inserted[t.name]) await admin.from(t.name).delete().eq('id', inserted[t.name]);
  }
  await admin.from('companies').delete().eq('id', foreignId);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
