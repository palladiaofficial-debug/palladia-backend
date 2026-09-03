#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_economia_spese_generali_api.js
 *
 * Test di regressione HTTP per il BLOCCO 5 del modulo Controllo Economico
 * (AUDIT.md F-119) — percentuale spese generali, margine netto nell'overview,
 * confronto tra cantieri. Chiamate reali contro l'API di produzione, stesso
 * pattern delle suite dei blocchi precedenti.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY      = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE      = process.env.ISOLATION_API_BASE || 'https://palladia-backend-production.up.railway.app/api/v1';

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
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
  console.log('\nPalladia — Controllo Economico BLOCCO 5: spese generali + confronto cantieri (regressione HTTP)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY,    { auth: { autoRefreshToken: false, persistSession: false } });

  const email = `test-economia-spese-generali-${Date.now()}@palladia-test.internal`;
  let companyId, otherCompanyId, siteAId, siteBId, siteNoBudgetId, userId;

  try {
    const { data: company } = await admin.from('companies').insert({ name: 'TEST-EconomiaSpeseGenerali-API', moltiplicatore_costo_manodopera: 1.00 }).select().single();
    companyId = company.id;
    const { data: siteA } = await admin.from('sites').insert({ company_id: companyId, name: 'TEST site A (margine alto)', status: 'attivo', address: 'Via Test A' }).select().single();
    siteAId = siteA.id;
    const { data: siteB } = await admin.from('sites').insert({ company_id: companyId, name: 'TEST site B (margine basso)', status: 'attivo', address: 'Via Test B' }).select().single();
    siteBId = siteB.id;
    const { data: siteC } = await admin.from('sites').insert({ company_id: companyId, name: 'TEST site senza budget', status: 'attivo', address: 'Via Test C' }).select().single();
    siteNoBudgetId = siteC.id;
    const { data: otherCompany } = await admin.from('companies').insert({ name: 'TEST-EconomiaSpeseGenerali-API-Other' }).select().single();
    otherCompanyId = otherCompany.id;

    const { data: userRes, error: userErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    check('Utente di test creato', !userErr && userRes?.user, userErr);
    userId = userRes.user.id;
    await admin.from('company_users').insert({ company_id: companyId, user_id: userId, role: 'owner' });
    await admin.from('company_users').insert({ company_id: otherCompanyId, user_id: userId, role: 'owner' });
    await admin.from('company_feature_flags').insert({ company_id: companyId, feature: 'economia_controllo_v1', enabled: true });

    const jwt = await sessionFor(admin, anon, email);
    check('Sessione JWT ottenuta', !!jwt);

    // ── Guardiano flag ─────────────────────────────────────────────────
    {
      const r = await apiCall(jwt, otherCompanyId, 'GET', '/economia-controllo/spese-generali');
      check('Spese generali: company senza flag riceve 404', r.status === 404, r);
    }

    // ── GET default ────────────────────────────────────────────────────
    {
      const r = await apiCall(jwt, companyId, 'GET', '/economia-controllo/spese-generali');
      check('GET spese-generali — default 0% con spiegazione in chiaro', r.status === 200 && r.body.percentuale_spese_generali === 0 && typeof r.body.spiegazione === 'string' && r.body.spiegazione.length > 10, r.body);
    }

    // ── PATCH validazione range ──────────────────────────────────────────
    {
      const r = await apiCall(jwt, companyId, 'PATCH', '/economia-controllo/spese-generali', { percentuale_spese_generali: 150 });
      check('PATCH con valore fuori range (150) rifiutato', r.status === 400, r);
    }

    // ── PATCH valido + riflesso su GET ───────────────────────────────────
    {
      const r1 = await apiCall(jwt, companyId, 'PATCH', '/economia-controllo/spese-generali', { percentuale_spese_generali: 10 });
      check('PATCH spese-generali (10%) accettato', r1.status === 200, r1);
      const r2 = await apiCall(jwt, companyId, 'GET', '/economia-controllo/spese-generali');
      check('GET dopo PATCH riflette il nuovo valore', r2.body?.percentuale_spese_generali === 10, r2.body);
    }

    // ── Budget su siteA e siteB, margine netto nell'overview ─────────────
    {
      await apiCall(jwt, companyId, 'PATCH', `/sites/${siteAId}/economia-controllo/budget-manuale`, { manodopera: 10000 });
      const r = await apiCall(jwt, companyId, 'GET', `/sites/${siteAId}/economia-controllo/overview`);
      // budget 10000, nessun costo -> margine diretto 10000 (100%), quota spese generali 10% di 10000 = 1000
      // margine netto = 10000 - 1000 = 9000 (90%)
      check('Overview: spese_generali.quota = 1000 (10% di 10000)', r.body?.spese_generali?.quota === 1000 && r.body?.spese_generali?.percentuale === 10, r.body?.spese_generali);
      check('Overview: margine_netto = 9000/90% (margine diretto 10000 meno la quota)', r.body?.margine_netto?.valore === 9000 && r.body?.margine_netto?.percentuale === 90, r.body?.margine_netto);
      check('Overview: margine diretto resta 10000/100% (i due numeri non si confondono)', r.body?.margine?.valore === 10000 && r.body?.margine?.percentuale === 100, r.body?.margine);
    }

    // ── Confronto cantieri ────────────────────────────────────────────────
    {
      // siteB: budget più piccolo ma con un costo che abbassa il margine netto sotto siteA
      await apiCall(jwt, companyId, 'PATCH', `/sites/${siteBId}/economia-controllo/budget-manuale`, { manodopera: 5000 });
      const { data: exp } = await admin.from('company_expenses').insert({
        company_id: companyId, site_id: siteBId, amount: 3000, description: 'TEST costo alto per abbassare il margine',
        category: 'materiali', expense_date: new Date().toISOString().slice(0, 10),
      }).select().single();

      const r = await apiCall(jwt, companyId, 'GET', '/economia-controllo/confronto-cantieri');
      check('Confronto cantieri: 200, percentuale spese generali coerente', r.status === 200 && r.body.percentuale_spese_generali === 10, r.body);
      check('Confronto cantieri: cantiere senza budget escluso dalla lista', r.body?.cantieri?.every(c => c.site_id !== siteNoBudgetId) && r.body?.cantieri_esclusi_senza_budget >= 1, r.body);

      const a = r.body?.cantieri?.find(c => c.site_id === siteAId);
      const b = r.body?.cantieri?.find(c => c.site_id === siteBId);
      check('Confronto cantieri: siteA presente con margine netto 90%', a?.margine_netto?.percentuale === 90, a);
      // siteB: budget 5000, costo 3000 -> margine diretto 2000 (40%), quota 10%*5000=500, netto 1500 (30%)
      check('Confronto cantieri: siteB presente con margine netto 30%', b?.margine_netto?.percentuale === 30, b);

      const idxA = r.body.cantieri.findIndex(c => c.site_id === siteAId);
      const idxB = r.body.cantieri.findIndex(c => c.site_id === siteBId);
      check('Confronto cantieri: ordinati per margine netto decrescente (A 90% prima di B 30%)', idxA !== -1 && idxB !== -1 && idxA < idxB, { idxA, idxB });

      await admin.from('company_expenses').delete().eq('id', exp.id);
    }

    // ── Cross-tenant ──────────────────────────────────────────────────────
    {
      const r = await apiCall(jwt, otherCompanyId, 'GET', '/economia-controllo/confronto-cantieri');
      check('Cross-tenant: altra company senza flag riceve 404 su confronto-cantieri', r.status === 404, r);
    }
  } finally {
    try { if (siteAId) await admin.from('sites').delete().eq('id', siteAId); } catch { /* best-effort */ }
    try { if (siteBId) await admin.from('sites').delete().eq('id', siteBId); } catch { /* best-effort */ }
    try { if (siteNoBudgetId) await admin.from('sites').delete().eq('id', siteNoBudgetId); } catch { /* best-effort */ }
    try { if (companyId) await admin.from('company_feature_flags').delete().eq('company_id', companyId).eq('feature', 'economia_controllo_v1'); } catch { /* best-effort */ }
    try { if (userId) await admin.auth.admin.deleteUser(userId); } catch { /* best-effort */ }
    try { if (companyId) await admin.from('companies').delete().eq('id', companyId); } catch { /* best-effort */ }
    try { if (otherCompanyId) await admin.from('companies').delete().eq('id', otherCompanyId); } catch { /* best-effort */ }
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
