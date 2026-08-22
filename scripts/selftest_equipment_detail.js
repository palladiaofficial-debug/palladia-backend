#!/usr/bin/env node
/**
 * scripts/selftest_equipment_detail.js
 *
 * Regressione per GET /api/v1/equipment/:id (Totale Controllo Fase 3, AUDIT.md):
 * nuovo endpoint aggiunto per dare a Mezzi la stessa pagina propria già
 * costruita per Lavoratori/Subappaltatori, stesso pattern di
 * GET /subcontractors/:id (nessun filtro is_active, isolamento per company).
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { createClient } = require('@supabase/supabase-js');

const API_URL = `http://localhost:${process.env.PORT || 3001}`;

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got, null, 2).slice(0, 500)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

// Client separato solo per l'autenticazione: signInWithPassword sul client
// service-role condiviso ne sostituirebbe la sessione interna — le chiamate
// admin successive (altre company/utenti di test) finirebbero sotto RLS
// invece che bypassarla. Stesso pattern di selftest_presence_closure.js.
async function makeSession(companyName) {
  const { data: company, error } = await supabase.from('companies').insert({ name: companyName }).select().single();
  if (error) throw error;
  const email = `test-eq-detail-${company.id}@palladia-test.internal`;
  const { data: userRes, error: userErr } = await supabase.auth.admin.createUser({ email, password: 'Test1234!Probe', email_confirm: true });
  if (userErr) throw userErr;
  await supabase.from('company_users').insert({ company_id: company.id, user_id: userRes.user.id, role: 'owner' });

  const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
  const { data: signIn, error: signInErr } = await authClient.auth.signInWithPassword({ email, password: 'Test1234!Probe' });
  if (signInErr) throw signInErr;

  return { companyId: company.id, userId: userRes.user.id, jwt: signIn.session.access_token, cleanup: async () => {
    await supabase.from('companies').delete().eq('id', company.id);
    await supabase.auth.admin.deleteUser(userRes.user.id);
  } };
}

async function main() {
  console.log('\n=== selftest_equipment_detail ===\n');

  const a = await makeSession('TEST-Equipment-Detail-A');
  const b = await makeSession('TEST-Equipment-Detail-B');

  try {
    const createRes = await fetch(`${API_URL}/api/v1/equipment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.jwt}`, 'X-Company-Id': a.companyId },
      body: JSON.stringify({ type: 'Escavatore', model: 'CAT 320', plateOrSerial: 'SN-TEST-001', ownership: 'Aziendale' }),
    });
    check('Creazione mezzo riuscita', createRes.status === 201, createRes.status);
    const created = await createRes.json();
    check('Nome leggibile calcolato alla creazione', created.name === 'Escavatore CAT 320', created);

    const getRes = await fetch(`${API_URL}/api/v1/equipment/${created.id}`, {
      headers: { Authorization: `Bearer ${a.jwt}`, 'X-Company-Id': a.companyId },
    });
    check('GET /equipment/:id → 200', getRes.status === 200, getRes.status);
    const fetched = await getRes.json();
    check('GET /equipment/:id ritorna lo stesso mezzo', fetched.id === created.id && fetched.type === 'Escavatore' && fetched.plateOrSerial === 'SN-TEST-001', fetched);

    const notFoundRes = await fetch(`${API_URL}/api/v1/equipment/00000000-0000-4000-8000-000000000000`, {
      headers: { Authorization: `Bearer ${a.jwt}`, 'X-Company-Id': a.companyId },
    });
    check('GET /equipment/:id con id inesistente → 404', notFoundRes.status === 404, notFoundRes.status);

    const crossCompanyRes = await fetch(`${API_URL}/api/v1/equipment/${created.id}`, {
      headers: { Authorization: `Bearer ${b.jwt}`, 'X-Company-Id': b.companyId },
    });
    check('GET /equipment/:id da un\'altra company → 404 (isolamento)', crossCompanyRes.status === 404, crossCompanyRes.status);

    const patchRes = await fetch(`${API_URL}/api/v1/equipment/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.jwt}`, 'X-Company-Id': a.companyId },
      body: JSON.stringify({ model: 'CAT 330' }),
    });
    check('PATCH riuscito', patchRes.status === 200, patchRes.status);

    const afterPatch = await (await fetch(`${API_URL}/api/v1/equipment/${created.id}`, {
      headers: { Authorization: `Bearer ${a.jwt}`, 'X-Company-Id': a.companyId },
    })).json();
    check('GET /equipment/:id riflette il PATCH (model)', afterPatch.model === 'CAT 330', afterPatch);
    check('GET /equipment/:id riflette il nome ricalcolato', afterPatch.name === 'Escavatore CAT 330', afterPatch);

    const noAuthRes = await fetch(`${API_URL}/api/v1/equipment/${created.id}`);
    check('GET /equipment/:id senza JWT → 401', noAuthRes.status === 401, noAuthRes.status);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
