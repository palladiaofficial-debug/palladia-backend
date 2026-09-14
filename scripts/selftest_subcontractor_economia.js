#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_subcontractor_economia.js
 *
 * Regressione per F-188 (AUDIT.md, 2026-09-14): il titolare ha chiesto una
 * tabella per ogni subappaltatore con tutti i cantieri attivi con lui,
 * appalto totale, acconti dati e % di avanzamento — esempio reale: un
 * subappaltatore ponteggi con ~16 cantieri attivi in contemporanea.
 *
 * Verifica dal vivo, HTTP reale, con lo stesso JWT che userebbe l'app:
 * 1) un subappaltatore assegnato a 2 cantieri, con appalto/% impostati
 *    separatamente su ciascuno (stesso subappaltatore, contratti diversi).
 * 2) i costi collegati (site_costs.subcontractor_id) si sommano per tipo
 *    (acconto/fattura) SOLO sul cantiere giusto, mai mescolati tra cantieri
 *    né con costi di altri subappaltatori sullo stesso cantiere.
 * 3) saldo_da_erogare e importo_maturato calcolati correttamente.
 * 4) un cantiere chiuso non compare nell'elenco "cantieri attivi".
 * 5) PATCH .../economia rifiuta un subappaltatore non assegnato a quel
 *    cantiere (mai scrivere un dato economico su un abbinamento inesistente).
 * 6) POST .../costs rifiuta un subcontractor_id non assegnato al cantiere
 *    (stessa protezione lato scrittura costi).
 * 7) isolamento multi-tenant: il JWT di un'altra azienda non vede nulla.
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
  console.log('\nPalladia regression — economia per subappaltatore, appalto/acconti/% su più cantieri (F-188)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('subcontractor economia', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY,    { auth: { autoRefreshToken: false, persistSession: false } });

  async function makeCompanyWithOwner(name) {
    const { data: company } = await admin.from('companies').insert([{ name }]).select('id').single();
    const email = `test-f188-${crypto.randomUUID()}@example.com`;
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

  const A = await makeCompanyWithOwner('TEST-F188-EconomiaA');
  const B = await makeCompanyWithOwner('TEST-F188-EconomiaB');
  const jwtA = await jwtFor(A.email);
  const jwtB = await jwtFor(B.email);

  function api(jwt, companyId) {
    return {
      get:   (p)    => fetch(BASE + p, { headers: { Authorization: 'Bearer ' + jwt, 'X-Company-Id': companyId } }).then(async r => ({ status: r.status, body: await r.json() })),
      post:  (p, b) => fetch(BASE + p, { method: 'POST',  headers: { Authorization: 'Bearer ' + jwt, 'X-Company-Id': companyId, 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() })),
      patch: (p, b) => fetch(BASE + p, { method: 'PATCH', headers: { Authorization: 'Bearer ' + jwt, 'X-Company-Id': companyId, 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() })),
    };
  }
  const apiA = api(jwtA, A.company.id);
  const apiB = api(jwtB, B.company.id);

  // ── Fixture: 1 subappaltatore, 2 cantieri attivi + 1 chiuso, tutti in A ──
  const { data: ponteggi } = await admin.from('subcontractors').insert([{ company_id: A.company.id, company_name: 'TEST-F188 Ponteggi Srl', is_active: true }]).select('id').single();
  const { data: altroSub } = await admin.from('subcontractors').insert([{ company_id: A.company.id, company_name: 'TEST-F188 Altro Sub', is_active: true }]).select('id').single();
  const { data: siteAlfa } = await admin.from('sites').insert([{ company_id: A.company.id, name: 'TEST-F188 Cantiere Alfa', address: 'Via Test', status: 'attivo' }]).select('id').single();
  const { data: siteBeta } = await admin.from('sites').insert([{ company_id: A.company.id, name: 'TEST-F188 Cantiere Beta', address: 'Via Test', status: 'attivo' }]).select('id').single();
  const { data: siteChiuso } = await admin.from('sites').insert([{ company_id: A.company.id, name: 'TEST-F188 Cantiere Chiuso', address: 'Via Test', status: 'chiuso' }]).select('id').single();

  await admin.from('site_subcontractors').insert([
    { company_id: A.company.id, site_id: siteAlfa.id, subcontractor_id: ponteggi.id },
    { company_id: A.company.id, site_id: siteBeta.id, subcontractor_id: ponteggi.id },
    { company_id: A.company.id, site_id: siteChiuso.id, subcontractor_id: ponteggi.id },
  ]);

  // ── 1. Imposta appalto/% separati sui due cantieri attivi ────────────────
  const r1 = await apiA.patch(`/subcontractors/${ponteggi.id}/sites/${siteAlfa.id}/economia`, { budget_totale: 50000, sal_percentuale: 40 });
  check('PATCH economia Alfa riesce (200)', r1.status === 200, r1);
  const r2 = await apiA.patch(`/subcontractors/${ponteggi.id}/sites/${siteBeta.id}/economia`, { budget_totale: 30000, sal_percentuale: 20 });
  check('PATCH economia Beta riesce (200)', r2.status === 200, r2);

  // ── 2. Costi collegati — acconti/fatture su Alfa, un costo diverso su Beta ──
  const c1 = await apiA.post(`/sites/${siteAlfa.id}/costs`, { descrizione: 'Acconto 1', importo: 10000, tipo: 'acconto', subcontractor_id: ponteggi.id });
  check('POST costo con subcontractor_id assegnato riesce', c1.status === 201, c1);
  const c2 = await apiA.post(`/sites/${siteAlfa.id}/costs`, { descrizione: 'Acconto 2', importo: 5000, tipo: 'acconto', subcontractor_id: ponteggi.id });
  check('secondo acconto su Alfa riesce', c2.status === 201, c2);
  const c3 = await apiA.post(`/sites/${siteAlfa.id}/costs`, { descrizione: 'Fattura finale', importo: 8000, tipo: 'fattura', subcontractor_id: ponteggi.id });
  check('fattura su Alfa riesce', c3.status === 201, c3);
  const c4 = await apiA.post(`/sites/${siteBeta.id}/costs`, { descrizione: 'Acconto Beta', importo: 3000, tipo: 'acconto', subcontractor_id: ponteggi.id });
  check('acconto su Beta riesce', c4.status === 201, c4);
  // Costo di un ALTRO subappaltatore sullo stesso cantiere Alfa — non deve mai sommarsi a Ponteggi
  await admin.from('site_subcontractors').insert([{ company_id: A.company.id, site_id: siteAlfa.id, subcontractor_id: altroSub.id }]);
  const c5 = await apiA.post(`/sites/${siteAlfa.id}/costs`, { descrizione: 'Costo altro sub', importo: 99999, tipo: 'acconto', subcontractor_id: altroSub.id });
  check('costo di un ALTRO subappaltatore sullo stesso cantiere riesce', c5.status === 201, c5);

  // ── 3. GET economia — verifica i numeri esatti ───────────────────────────
  const eco = await apiA.get(`/subcontractors/${ponteggi.id}/economia`);
  check('GET economia risponde 200', eco.status === 200, eco);
  const bySite = Object.fromEntries((eco.body.sites || []).map(s => [s.site_id, s]));

  check('esattamente 2 cantieri attivi (il chiuso è escluso)', eco.body.sites.length === 2, eco.body.sites.map(s => s.site_name));
  check('Alfa: appalto totale 50000', bySite[siteAlfa.id]?.budget_totale === 50000, bySite[siteAlfa.id]);
  check('Alfa: acconti dati = 15000 (10000+5000), MAI 99999 dell\'altro sub', bySite[siteAlfa.id]?.acconti_dati === 15000, bySite[siteAlfa.id]);
  check('Alfa: fatturato = 8000', bySite[siteAlfa.id]?.fatturato === 8000, bySite[siteAlfa.id]);
  check('Alfa: importo maturato = 50000*40% = 20000', bySite[siteAlfa.id]?.importo_maturato === 20000, bySite[siteAlfa.id]);
  check('Alfa: saldo da erogare = 50000-15000 = 35000', bySite[siteAlfa.id]?.saldo_da_erogare === 35000, bySite[siteAlfa.id]);

  // ── F-191 (AUDIT.md): dettaglio pagamenti inline per cantiere ────────────
  const alfaPayments = bySite[siteAlfa.id]?.payments || [];
  check('Alfa: 3 pagamenti nel dettaglio (2 acconti + 1 fattura), MAI il costo dell\'altro sub',
    alfaPayments.length === 3, alfaPayments);
  check('Alfa: i due acconti singoli compaiono con l\'importo esatto (10000 e 5000)',
    alfaPayments.filter(p => p.tipo === 'acconto').map(p => p.importo).sort((a, b) => a - b).join(',') === '5000,10000', alfaPayments);
  check('Alfa: la fattura compare con l\'importo esatto (8000)',
    alfaPayments.some(p => p.tipo === 'fattura' && p.importo === 8000), alfaPayments);
  const betaPayments = bySite[siteBeta.id]?.payments || [];
  check('Beta: 1 solo pagamento nel dettaglio, indipendente da Alfa',
    betaPayments.length === 1 && betaPayments[0].importo === 3000, betaPayments);
  check('Beta: appalto totale 30000, acconti 3000, indipendente da Alfa', bySite[siteBeta.id]?.budget_totale === 30000 && bySite[siteBeta.id]?.acconti_dati === 3000, bySite[siteBeta.id]);
  check('totali: appalti 80000, acconti 18000, fatturato 8000', eco.body.totals.totale_appalti === 80000 && eco.body.totals.totale_acconti === 18000 && eco.body.totals.totale_fatturato === 8000, eco.body.totals);

  // ── 4. Protezioni ─────────────────────────────────────────────────────────
  const rBad = await apiA.patch(`/subcontractors/${ponteggi.id}/sites/${siteChiuso.id}/economia`, { budget_totale: 1 });
  // siteChiuso E' assegnato (per costruzione test) quindi questo deve riuscire — verifica invece un cantiere MAI assegnato
  const { data: siteNonAssegnato } = await admin.from('sites').insert([{ company_id: A.company.id, name: 'TEST-F188 Non Assegnato', address: 'Via Test', status: 'attivo' }]).select('id').single();
  const rNotAssigned = await apiA.patch(`/subcontractors/${ponteggi.id}/sites/${siteNonAssegnato.id}/economia`, { budget_totale: 1 });
  check('PATCH economia su un cantiere NON assegnato → 404, nessuna scrittura fantasma', rNotAssigned.status === 404, rNotAssigned);

  const cBadSub = await apiA.post(`/sites/${siteNonAssegnato.id}/costs`, { descrizione: 'x', importo: 1, tipo: 'acconto', subcontractor_id: ponteggi.id });
  check('POST costo con subcontractor_id NON assegnato al cantiere → 400, nessuna scrittura', cBadSub.status === 400, cBadSub);

  // ── 5. Isolamento multi-tenant ────────────────────────────────────────────
  const ecoB = await apiB.get(`/subcontractors/${ponteggi.id}/economia`);
  check('company B non vede l\'economia del subappaltatore di company A (404)', ecoB.status === 404, ecoB);

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
