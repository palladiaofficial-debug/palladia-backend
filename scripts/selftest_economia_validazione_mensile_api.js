#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_economia_validazione_mensile_api.js
 *
 * Test di regressione HTTP per lo strumento di validazione mensile del
 * modulo Controllo Economico (AUDIT.md F-119, sezione VALIDAZIONE) —
 * POST/GET /economia-controllo/validazione-mensile. Chiamate reali contro
 * l'API di produzione.
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
  console.log('\nPalladia — Controllo Economico: strumento di validazione mensile (regressione HTTP)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY,    { auth: { autoRefreshToken: false, persistSession: false } });

  const email = `test-economia-validazione-${Date.now()}@palladia-test.internal`;
  let companyId, siteId, userId;

  try {
    const { data: company } = await admin.from('companies').insert({ name: 'TEST-EconomiaValidazione-API', moltiplicatore_costo_manodopera: 1.00 }).select().single();
    companyId = company.id;
    const { data: site } = await admin.from('sites').insert({ company_id: companyId, name: 'TEST site validazione', status: 'attivo', address: 'Via Test 1' }).select().single();
    siteId = site.id;

    const { data: userRes, error: userErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    check('Utente di test creato', !userErr && userRes?.user, userErr);
    userId = userRes.user.id;
    await admin.from('company_users').insert({ company_id: companyId, user_id: userId, role: 'owner' });
    await admin.from('company_feature_flags').insert({ company_id: companyId, feature: 'economia_controllo_v1', enabled: true });

    const jwt = await sessionFor(admin, anon, email);
    check('Sessione JWT ottenuta', !!jwt);

    await apiCall(jwt, companyId, 'PATCH', `/sites/${siteId}/economia-controllo/budget-manuale`, { manodopera: 10000 });
    // margine Palladia atteso: budget 10000, nessun costo -> margine 10000 (0% spese generali di default)

    // ── Mese 1 (2 mesi fa): scostamento alto (>5%) ────────────────────────
    const meseFa = (n) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
    {
      const r = await apiCall(jwt, companyId, 'POST', '/economia-controllo/validazione-mensile', {
        site_id: siteId, mese: meseFa(2), margine_reale: 7000, // |7000-10000|/7000*100 = 42.9% (percentuale d'errore standard, denominatore = valore reale)
      });
      check('POST validazione mensile (mese-2, scostamento alto) creato', r.status === 201 && r.body.margine_palladia === 10000, r.body);
      check('Scostamento calcolato correttamente (42.9%, denominatore = margine reale)', r.body?.scostamento_pct === 42.9, r.body);
    }

    // ── Mese 2 e 3 (i 2 più recenti): scostamento basso (<5%) ─────────────
    {
      const r1 = await apiCall(jwt, companyId, 'POST', '/economia-controllo/validazione-mensile', {
        site_id: siteId, mese: meseFa(1), margine_reale: 9800, // 2% di scostamento
      });
      check('POST validazione mensile (mese-1, scostamento basso) creato', r1.status === 201, r1);

      const r2 = await apiCall(jwt, companyId, 'POST', '/economia-controllo/validazione-mensile', {
        site_id: siteId, mese: meseFa(0), margine_reale: 9900, // 1% di scostamento
      });
      check('POST validazione mensile (mese corrente, scostamento basso) creato', r2.status === 201, r2);
    }

    // ── Upsert: reinviare lo stesso mese aggiorna, non duplica ────────────
    {
      const r = await apiCall(jwt, companyId, 'POST', '/economia-controllo/validazione-mensile', {
        site_id: siteId, mese: meseFa(0), margine_reale: 9950, note: 'corretto',
      });
      check('POST sullo stesso mese aggiorna (upsert), non duplica', r.status === 201, r);
    }

    // ── GET: riepilogo + verdetto ──────────────────────────────────────────
    {
      const r = await apiCall(jwt, companyId, 'GET', '/economia-controllo/validazione-mensile');
      check('GET validazione mensile: 3 voci (una per mese, upsert non ha duplicato)', r.body?.voci?.length === 3, r.body?.voci);
      // Solo gli ultimi 2 mesi (i più recenti) sono sotto il 5% — il mese più vecchio (42.9%) rompe la striscia
      check('Verdetto: solo 2 mesi consecutivi sotto soglia (il terzo, più vecchio, ha 42.9%)', r.body?.mesi_consecutivi_sotto_soglia === 2, r.body);
      check('Verdetto: NON ancora pronto per altri clienti (servono 3 consecutivi, non solo 2)', r.body?.pronto_per_altri_clienti === false, r.body);
      check('Messaggio verdetto presente e leggibile', typeof r.body?.messaggio === 'string' && r.body.messaggio.length > 10, r.body?.messaggio);
    }

    // ── Guardiano flag ─────────────────────────────────────────────────
    {
      const { data: otherCompany } = await admin.from('companies').insert({ name: 'TEST-EconomiaValidazione-API-Other' }).select().single();
      await admin.from('company_users').insert({ company_id: otherCompany.id, user_id: userId, role: 'owner' });
      const r = await apiCall(jwt, otherCompany.id, 'GET', '/economia-controllo/validazione-mensile');
      check('Company senza flag riceve 404', r.status === 404, r);
      await admin.from('companies').delete().eq('id', otherCompany.id);
    }
  } finally {
    try { if (siteId) await admin.from('economia_validazione_mensile').delete().eq('site_id', siteId); } catch { /* best-effort */ }
    try { if (companyId) await admin.from('company_feature_flags').delete().eq('company_id', companyId).eq('feature', 'economia_controllo_v1'); } catch { /* best-effort */ }
    try { if (userId) await admin.auth.admin.deleteUser(userId); } catch { /* best-effort */ }
    try { if (siteId) await admin.from('sites').delete().eq('id', siteId); } catch { /* best-effort */ }
    try { if (companyId) await admin.from('companies').delete().eq('id', companyId); } catch { /* best-effort */ }
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
