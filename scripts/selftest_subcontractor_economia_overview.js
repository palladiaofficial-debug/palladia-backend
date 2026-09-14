#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_subcontractor_economia_overview.js
 *
 * Regressione per F-190 (AUDIT.md, 2026-09-14): dopo la schermata Economia
 * per-subappaltatore, il titolare ha chiesto un modo di vedere "a chi devo
 * di più" senza entrare in ognuno uno alla volta.
 *
 * Verifica dal vivo, HTTP reale, con lo stesso JWT che userebbe l'app:
 * 1) 3 subappaltatori con saldi diversi → ordinati per saldo da erogare
 *    DECRESCENTE.
 * 2) un subappaltatore disattivato (is_active=false) non compare.
 * 3) un cantiere chiuso non conta nei "cantieri attivi" né nel suo appalto.
 * 4) un subappaltatore senza nessun appalto impostato compare comunque
 *    (visibilità, non sparisce silenziosamente) con saldo "—".
 * 5) isolamento multi-tenant.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const BASE          = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — riepilogo economia su tutti i subappaltatori, ordinato per saldo (F-190)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('subcontractors economia overview', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY,    { auth: { autoRefreshToken: false, persistSession: false } });

  async function makeCompanyWithOwner(name) {
    const { data: company } = await admin.from('companies').insert([{ name }]).select('id').single();
    const email = `test-f190-${crypto.randomUUID()}@example.com`;
    const { data: userRes, error: userErr } = await admin.auth.admin.createUser({ email, email_confirm: true, password: crypto.randomUUID() });
    if (userErr) throw new Error('createUser: ' + userErr.message);
    await admin.from('company_users').insert([{ company_id: company.id, user_id: userRes.user.id, role: 'owner' }]);
    return { company, userId: userRes.user.id, email };
  }
  async function jwtFor(email) {
    const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (error) throw error;
    const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
    const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
    if (verErr) throw verErr;
    return verified.session.access_token;
  }

  const A = await makeCompanyWithOwner('TEST-F190-OverviewA');
  const B = await makeCompanyWithOwner('TEST-F190-OverviewB');
  const jwtA = await jwtFor(A.email);
  const jwtB = await jwtFor(B.email);

  async function makeSub(name, isActive = true) {
    const { data } = await admin.from('subcontractors').insert([{ company_id: A.company.id, company_name: name, is_active: isActive }]).select('id').single();
    return data.id;
  }
  async function makeSite(name, status = 'attivo') {
    const { data } = await admin.from('sites').insert([{ company_id: A.company.id, name, address: 'Via Test', status }]).select('id').single();
    return data.id;
  }

  // Sub 1: saldo alto (30000 - 5000 = 25000)
  const sub1 = await makeSub('TEST-F190 Subappaltatore Saldo Alto');
  const site1 = await makeSite('TEST-F190 Cantiere 1');
  await admin.from('site_subcontractors').insert([{ company_id: A.company.id, site_id: site1, subcontractor_id: sub1, budget_totale: 30000, sal_percentuale: 50 }]);
  await admin.from('site_costs').insert([{ company_id: A.company.id, site_id: site1, subcontractor_id: sub1, descrizione: 'Acconto', importo: 5000, tipo: 'acconto' }]);

  // Sub 2: saldo basso (10000 - 9000 = 1000)
  const sub2 = await makeSub('TEST-F190 Subappaltatore Saldo Basso');
  const site2 = await makeSite('TEST-F190 Cantiere 2');
  await admin.from('site_subcontractors').insert([{ company_id: A.company.id, site_id: site2, subcontractor_id: sub2, budget_totale: 10000, sal_percentuale: 90 }]);
  await admin.from('site_costs').insert([{ company_id: A.company.id, site_id: site2, subcontractor_id: sub2, descrizione: 'Acconto', importo: 9000, tipo: 'acconto' }]);
  // Cantiere chiuso per sub2 — non deve contare
  const siteChiuso = await makeSite('TEST-F190 Cantiere Chiuso', 'chiuso');
  await admin.from('site_subcontractors').insert([{ company_id: A.company.id, site_id: siteChiuso, subcontractor_id: sub2, budget_totale: 99999, sal_percentuale: 0 }]);

  // Sub 3: nessun appalto impostato — deve comunque comparire
  const sub3 = await makeSub('TEST-F190 Subappaltatore Senza Appalto');
  const site3 = await makeSite('TEST-F190 Cantiere 3');
  await admin.from('site_subcontractors').insert([{ company_id: A.company.id, site_id: site3, subcontractor_id: sub3 }]);

  // Sub 4: disattivato — non deve comparire mai
  await makeSub('TEST-F190 Subappaltatore Disattivato', false);

  async function getOverview(jwt, companyId) {
    const r = await fetch(`${BASE}/subcontractors/economia-overview`, { headers: { Authorization: 'Bearer ' + jwt, 'X-Company-Id': companyId } });
    return { status: r.status, body: await r.json() };
  }

  const rA = await getOverview(jwtA, A.company.id);
  check('risponde 200', rA.status === 200, rA);
  const list = rA.body.subcontractors || [];
  const byId = Object.fromEntries(list.map(s => [s.subcontractor_id, s]));

  check('subappaltatore disattivato NON compare', !list.some(s => s.company_name.includes('Disattivato')), list.map(s => s.company_name));
  check('subappaltatore senza appalto compare comunque (visibilità)', !!byId[sub3], list.map(s => s.company_name));
  check('saldo "—" (null) per chi non ha appalto impostato', byId[sub3]?.saldo_da_erogare === null, byId[sub3]);
  check('Sub2: cantiere chiuso escluso — cantieri_attivi=1 (non 2), appalto=10000 (non 109999)',
    byId[sub2]?.cantieri_attivi === 1 && byId[sub2]?.totale_appalti === 10000, byId[sub2]);
  check('Sub1: saldo = 30000-5000 = 25000', byId[sub1]?.saldo_da_erogare === 25000, byId[sub1]);
  check('Sub2: saldo = 10000-9000 = 1000', byId[sub2]?.saldo_da_erogare === 1000, byId[sub2]);

  const idx1 = list.findIndex(s => s.subcontractor_id === sub1);
  const idx2 = list.findIndex(s => s.subcontractor_id === sub2);
  check('ordinamento: saldo alto (25000) prima di saldo basso (1000)', idx1 < idx2, { idx1, idx2, list: list.map(s => s.company_name) });

  const rB = await getOverview(jwtB, B.company.id);
  check('isolamento multi-tenant: company B non vede i subappaltatori di company A', (rB.body.subcontractors || []).length === 0, rB.body);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
