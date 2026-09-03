#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_economia_controllo_api.js
 *
 * Test di regressione HTTP per il BLOCCO 2 del modulo Controllo Economico
 * (AUDIT.md F-119) — routes/v1/economiaControllo.js: moltiplicatore
 * costo-azienda e CRUD contratti di subappalto. Chiamate reali contro
 * l'API (default produzione, come selftest_site_delete_coordinator_access.js),
 * con lo stesso JWT/header che userebbe l'app — non solo lettura di codice.
 *
 * Copre anche il guardiano del feature flag: una company senza
 * economia_controllo_v1 attivo deve ricevere 404, non un errore diverso o
 * un 200 con dati.
 *
 * Richiede: SUPABASE_URL, SUPABASE_ANON_KEY/SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY.
 * Se mancano, il test si salta (stesso pattern del resto della suite).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE      = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function sessionFor(admin, anon, email) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (linkErr) throw linkErr;
  const tokenHash = new URL(link.properties.action_link).searchParams.get('token');
  const { data: verified, error: verErr } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
  if (verErr) throw verErr;
  return verified.session.access_token;
}

async function apiCall(jwt, companyId, method, urlPath, body) {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let respBody = null;
  try { respBody = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body: respBody };
}

async function main() {
  console.log('\nPalladia — Controllo Economico BLOCCO 2: moltiplicatore + subappalti (regressione HTTP)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY,    { auth: { autoRefreshToken: false, persistSession: false } });

  const email = `test-economia-controllo-${Date.now()}@palladia-test.internal`;
  let companyId, otherCompanyId, siteId, userId, subcontractId;

  try {
    const { data: company } = await admin.from('companies').insert({ name: 'TEST-EconomiaControllo-API' }).select().single();
    companyId = company.id;
    const { data: site } = await admin.from('sites').insert({ company_id: companyId, name: 'TEST site API', status: 'attivo', address: 'Via Test 1' }).select().single();
    siteId = site.id;
    const { data: otherCompany } = await admin.from('companies').insert({ name: 'TEST-EconomiaControllo-API-Other' }).select().single();
    otherCompanyId = otherCompany.id;

    const { data: userRes, error: userErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    check('Utente di test creato', !userErr && userRes?.user, userErr);
    userId = userRes.user.id;
    await admin.from('company_users').insert({ company_id: companyId, user_id: userId, role: 'owner' });
    await admin.from('company_users').insert({ company_id: otherCompanyId, user_id: userId, role: 'owner' });

    // Il flag va attivato esplicitamente per la company di test (non è la
    // master company) — via override DB, lo stesso meccanismo che userebbe
    // un rollout mirato in produzione.
    await admin.from('company_feature_flags').insert({ company_id: companyId, feature: 'economia_controllo_v1', enabled: true });

    const jwt = await sessionFor(admin, anon, email);
    check('Sessione JWT ottenuta', !!jwt);

    // ── Guardiano feature flag: company SENZA flag attivo → 404 ──────────
    {
      const r = await apiCall(jwt, otherCompanyId, 'GET', '/economia-controllo/moltiplicatore');
      check('Company senza flag attivo riceve 404 (non 200/500)', r.status === 404, r);
    }

    // ── Moltiplicatore ─────────────────────────────────────────────────
    {
      const r1 = await apiCall(jwt, companyId, 'GET', '/economia-controllo/moltiplicatore');
      check('GET moltiplicatore — default 1.45 con spiegazione in chiaro', r1.status === 200 && r1.body.moltiplicatore_costo_manodopera === 1.45 && typeof r1.body.spiegazione === 'string' && r1.body.spiegazione.length > 10, r1);

      const r2 = await apiCall(jwt, companyId, 'PATCH', '/economia-controllo/moltiplicatore', { moltiplicatore_costo_manodopera: 1.60 });
      check('PATCH moltiplicatore accettato', r2.status === 200, r2);

      const r3 = await apiCall(jwt, companyId, 'GET', '/economia-controllo/moltiplicatore');
      check('GET dopo PATCH riflette il nuovo valore', r3.body.moltiplicatore_costo_manodopera === 1.6, r3);

      const r4 = await apiCall(jwt, companyId, 'PATCH', '/economia-controllo/moltiplicatore', { moltiplicatore_costo_manodopera: 5 });
      check('PATCH con valore fuori range (5) rifiutato', r4.status === 400, r4);
    }

    // ── Contratti di subappalto ────────────────────────────────────────
    {
      const r1 = await apiCall(jwt, companyId, 'POST', `/sites/${siteId}/subcontracts`, { descrizione: 'TEST API impianto elettrico', importo_pattuito: 12000, stato: 'emesso' });
      check('POST subcontract creato', r1.status === 201 && r1.body.id, r1);
      subcontractId = r1.body.id;

      const r2 = await apiCall(jwt, companyId, 'GET', `/sites/${siteId}/subcontracts`);
      const created = r2.body?.subcontracts?.find(c => c.id === subcontractId);
      check('GET subcontracts include il nuovo contratto con residuo_impegnato = importo', r2.status === 200 && created && created.residuo_impegnato === 12000, r2.body);

      const r3 = await apiCall(jwt, companyId, 'POST', `/sites/${siteId}/subcontracts/${subcontractId}/sal`, { importo: 5000 });
      check('POST sal creato', r3.status === 201, r3);
      const salId = r3.body.id;

      const r4 = await apiCall(jwt, companyId, 'GET', `/sites/${siteId}/subcontracts`);
      const afterSal = r4.body?.subcontracts?.find(c => c.id === subcontractId);
      check('Dopo il SAL, residuo_impegnato = 7000 (12000-5000), importo originale invariato', afterSal?.residuo_impegnato === 7000 && afterSal?.importo_pattuito === 12000, afterSal);

      const r5 = await apiCall(jwt, companyId, 'PATCH', `/sites/${siteId}/subcontracts/${subcontractId}`, { stato: 'chiuso' });
      check('PATCH subcontract (chiuso) accettato', r5.status === 200, r5);

      const rCross = await apiCall(jwt, otherCompanyId, 'GET', `/sites/${siteId}/subcontracts`);
      check('Cross-tenant: altra company non vede i contratti di questo cantiere (404, non lista vuota rivelante l\'esistenza del sito)', rCross.status === 404, rCross);

      await apiCall(jwt, companyId, 'DELETE', `/sites/${siteId}/subcontracts/${subcontractId}/sal/${salId}`);
      const r6 = await apiCall(jwt, companyId, 'DELETE', `/sites/${siteId}/subcontracts/${subcontractId}`);
      check('DELETE subcontract accettato', r6.status === 200, r6);
      subcontractId = null;
    }
  } finally {
    try { if (subcontractId) await admin.from('site_subcontracts').delete().eq('id', subcontractId); } catch { /* best-effort */ }
    try { if (companyId) await admin.from('company_feature_flags').delete().eq('company_id', companyId).eq('feature', 'economia_controllo_v1'); } catch { /* best-effort */ }
    try { if (userId) await admin.auth.admin.deleteUser(userId); } catch { /* best-effort */ }
    try { if (siteId) await admin.from('sites').delete().eq('id', siteId); } catch { /* best-effort */ }
    try { if (companyId) await admin.from('companies').delete().eq('id', companyId); } catch { /* best-effort */ }
    try { if (otherCompanyId) await admin.from('companies').delete().eq('id', otherCompanyId); } catch { /* best-effort */ }
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
