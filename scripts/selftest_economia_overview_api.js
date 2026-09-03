#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_economia_overview_api.js
 *
 * Test di regressione HTTP per il BLOCCO 3 del modulo Controllo Economico
 * (AUDIT.md F-119) — GET /sites/:siteId/economia-controllo/overview e
 * PATCH .../budget-manuale. Chiamate reali contro l'API (default produzione),
 * stesso pattern di selftest_economia_controllo_api.js (Blocco 2).
 *
 * Richiede: SUPABASE_URL, SUPABASE_ANON_KEY/SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY.
 * Se mancano, il test si salta.
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
  console.log('\nPalladia — Controllo Economico BLOCCO 3: overview + budget manuale (regressione HTTP)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY,    { auth: { autoRefreshToken: false, persistSession: false } });

  const email = `test-economia-overview-${Date.now()}@palladia-test.internal`;
  let companyId, otherCompanyId, siteId, cmeSiteId, userId, workerId, subcontractId, expenseId, computoId;

  try {
    const { data: company } = await admin.from('companies').insert({ name: 'TEST-EconomiaOverview-API', moltiplicatore_costo_manodopera: 1.00 }).select().single();
    companyId = company.id;
    const { data: site } = await admin.from('sites').insert({ company_id: companyId, name: 'TEST site overview', status: 'attivo', address: 'Via Test 1', sal_percentuale: 20 }).select().single();
    siteId = site.id;
    const { data: cmeSite } = await admin.from('sites').insert({ company_id: companyId, name: 'TEST site CME', status: 'attivo', address: 'Via Test 2' }).select().single();
    cmeSiteId = cmeSite.id;
    const { data: otherCompany } = await admin.from('companies').insert({ name: 'TEST-EconomiaOverview-API-Other' }).select().single();
    otherCompanyId = otherCompany.id;
    const { data: worker } = await admin.from('workers').insert({
      company_id: companyId, full_name: 'TEST Worker Overview',
      fiscal_code: `TSTEO${Date.now()}`.slice(0, 16).toUpperCase(), is_active: true,
      badge_code: `TSTEO${Date.now()}`, tariffa_oraria: 20,
    }).select().single();
    workerId = worker.id;

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
      const r = await apiCall(jwt, otherCompanyId, 'GET', `/sites/${siteId}/economia-controllo/overview`);
      check('Overview: company senza flag riceve 404', r.status === 404, r);
    }

    // ── Overview su cantiere vuoto: nessun errore, tutto a zero ─────────
    {
      const r = await apiCall(jwt, companyId, 'GET', `/sites/${siteId}/economia-controllo/overview`);
      check('Overview cantiere vuoto: 200, budget totale 0, margine null (nessun budget)',
        r.status === 200 && r.body.budget.totale === 0 && r.body.margine.valore === null, r.body);
      check('Overview cantiere vuoto: has_cme false', r.body?.has_cme === false, r.body);
    }

    // ── Budget manuale (no CME) ──────────────────────────────────────────
    {
      const r1 = await apiCall(jwt, companyId, 'PATCH', `/sites/${siteId}/economia-controllo/budget-manuale`, {
        manodopera: 10000, materiali: 15000, subappalti: 20000, noleggi: 5000,
      });
      check('PATCH budget-manuale accettato', r1.status === 200, r1);

      const r2 = await apiCall(jwt, companyId, 'GET', `/sites/${siteId}/economia-controllo/overview`);
      check('Overview riflette budget totale = 50000 (somma 4 categorie)', r2.body?.budget?.totale === 50000, r2.body?.budget);
      check('Overview: budget ripartito = true (manuale, non CME)', r2.body?.budget?.ripartito === true, r2.body?.budget);
      check('Margine su budget senza costi = 50000 (100%)', r2.body?.margine?.valore === 50000 && r2.body?.margine?.percentuale === 100, r2.body?.margine);
    }

    // ── company_expenses attribuita a cantiere → consuntivo materiali ────
    {
      const { data: exp } = await admin.from('company_expenses').insert({
        company_id: companyId, site_id: siteId, amount: 3000, description: 'TEST fattura materiali',
        category: 'materiali', expense_date: new Date().toISOString().slice(0, 10),
      }).select().single();
      expenseId = exp.id;

      const r = await apiCall(jwt, companyId, 'GET', `/sites/${siteId}/economia-controllo/overview`);
      check('Overview: fattura attribuita entra in consuntivo.materiali (3000)', r.body?.consuntivo?.per_categoria?.materiali === 3000, r.body?.consuntivo);
      check('Overview: affidabilita.fatture_count = 1', r.body?.affidabilita?.fatture_count === 1, r.body?.affidabilita);
    }

    // ── Timbrature → manodopera (moltiplicatore 1.00 per isolare il calcolo) ──
    {
      // Schema reale di presence_logs (verificato dal vivo, drift non tracciato
      // nelle migrazioni: niente action/scanned_at/timestamp_device come nella
      // 001 originale) — company_id/site_id/worker_id/event_type/timestamp_server.
      const day = new Date().toISOString().slice(0, 10);
      const { error: presenceErr } = await admin.from('presence_logs').insert([
        { company_id: companyId, site_id: siteId, worker_id: workerId, event_type: 'ENTRY', timestamp_server: `${day}T08:00:00Z` },
        { company_id: companyId, site_id: siteId, worker_id: workerId, event_type: 'EXIT',  timestamp_server: `${day}T16:00:00Z` },
      ]);
      check('Timbrature inserite senza errore', !presenceErr, presenceErr);
      const { error: syncErr } = await admin.rpc('sync_site_mo_consuntivo', { p_site_id: siteId });
      check('sync_site_mo_consuntivo eseguita senza errore', !syncErr, syncErr);

      const r = await apiCall(jwt, companyId, 'GET', `/sites/${siteId}/economia-controllo/overview`);
      check('Overview: 8h × 20€/h = 160€ in consuntivo.manodopera (moltiplicatore 1.00)', r.body?.consuntivo?.per_categoria?.manodopera === 160, r.body?.consuntivo);
      check('Overview: affidabilita.ore_totali = 8', r.body?.affidabilita?.ore_totali === 8, r.body?.affidabilita);
      check('Overview: nessun lavoratore senza tariffa (tariffa_oraria impostata)', (r.body?.affidabilita?.lavoratori_senza_tariffa || []).length === 0, r.body?.affidabilita);
    }

    // ── Subappalto emesso → impegnato, poi SAL → consuntivo (residuo invariato nell'impegnato) ──
    {
      const r1 = await apiCall(jwt, companyId, 'POST', `/sites/${siteId}/subcontracts`, { descrizione: 'TEST overview subappalto', importo_pattuito: 20000, stato: 'emesso' });
      subcontractId = r1.body.id;

      const rOv1 = await apiCall(jwt, companyId, 'GET', `/sites/${siteId}/economia-controllo/overview`);
      check('Overview: contratto emesso genera impegnato.subappalti = 20000', rOv1.body?.impegnato?.per_categoria?.subappalti === 20000, rOv1.body?.impegnato);

      await apiCall(jwt, companyId, 'POST', `/sites/${siteId}/subcontracts/${subcontractId}/sal`, { importo: 8000 });
      const rOv2 = await apiCall(jwt, companyId, 'GET', `/sites/${siteId}/economia-controllo/overview`);
      check('Overview: dopo SAL 8000, consuntivo.subappalti = 8000 e impegnato resta 20000 (non decrementato)',
        rOv2.body?.consuntivo?.per_categoria?.subappalti === 8000 && rOv2.body?.impegnato?.per_categoria?.subappalti === 20000, { consuntivo: rOv2.body?.consuntivo, impegnato: rOv2.body?.impegnato });

      // Costo a finire per subappalti = MAX(impegnato, consuntivo) = 20000 (non 20000+8000)
      // margine = 50000 budget - (160 mo + 3000 mat + 0 nolo + 0 altro + max(20000,8000)) = 50000 - 23160 = 26840
      check('Margine non somma impegnato+consuntivo subappalti (niente doppio conteggio): costo_a_finire = 23160',
        rOv2.body?.margine?.costo_a_finire === 23160, rOv2.body?.margine);
      check('Margine coerente: 50000 - 23160 = 26840', rOv2.body?.margine?.valore === 26840, rOv2.body?.margine);
    }

    // ── Allarme ritmo: avanzamento 20% ma costo consumato ben oltre ──────
    {
      const r = await apiCall(jwt, companyId, 'GET', `/sites/${siteId}/economia-controllo/overview`);
      // consuntivo totale = 160+3000+8000 = 11160 su budget 50000 = 22.32% > avanzamento 20%
      check('Allarme ritmo presente quando costo_consumato_pct > avanzamento_pct', r.body?.allarme_ritmo !== null && typeof r.body.allarme_ritmo.messaggio === 'string', r.body?.allarme_ritmo);
    }

    // ── CME: budget-manuale bloccato se esiste un computo base ──────────
    {
      const { data: computo } = await admin.from('site_computo').insert({
        company_id: companyId, site_id: cmeSiteId, tipo: 'base', nome: 'TEST computo', totale_contratto: 100000,
      }).select().single();
      computoId = computo.id;

      const r1 = await apiCall(jwt, companyId, 'GET', `/sites/${cmeSiteId}/economia-controllo/overview`);
      check('Overview su cantiere con CME: has_cme=true, budget da computo = 100000', r1.body?.has_cme === true && r1.body?.budget?.totale === 100000, r1.body);
      check('Overview su cantiere con CME: budget NON ripartito per categoria (CME scrive solo altro)', r1.body?.budget?.ripartito === false, r1.body?.budget);

      const r2 = await apiCall(jwt, companyId, 'PATCH', `/sites/${cmeSiteId}/economia-controllo/budget-manuale`, { manodopera: 1000 });
      check('PATCH budget-manuale su cantiere con CME rifiutato (409)', r2.status === 409, r2);
    }

    // ── Cross-tenant ──────────────────────────────────────────────────────
    {
      const r = await apiCall(jwt, otherCompanyId, 'GET', `/sites/${siteId}/economia-controllo/overview`);
      check('Cross-tenant: altra company non vede overview di questo cantiere (404)', r.status === 404, r);
    }
  } finally {
    try { if (computoId) await admin.from('site_computo').delete().eq('id', computoId); } catch { /* best-effort */ }
    try { if (subcontractId) await admin.from('site_subcontracts').delete().eq('id', subcontractId); } catch { /* best-effort */ }
    try { if (expenseId) await admin.from('company_expenses').delete().eq('id', expenseId); } catch { /* best-effort */ }
    try { if (workerId) await admin.from('presence_logs').delete().eq('worker_id', workerId); } catch { /* best-effort */ }
    try { if (workerId) await admin.from('workers').delete().eq('id', workerId); } catch { /* best-effort */ }
    try { if (companyId) await admin.from('company_feature_flags').delete().eq('company_id', companyId).eq('feature', 'economia_controllo_v1'); } catch { /* best-effort */ }
    try { if (userId) await admin.auth.admin.deleteUser(userId); } catch { /* best-effort */ }
    try { if (siteId) await admin.from('sites').delete().eq('id', siteId); } catch { /* best-effort */ }
    try { if (cmeSiteId) await admin.from('sites').delete().eq('id', cmeSiteId); } catch { /* best-effort */ }
    try { if (companyId) await admin.from('companies').delete().eq('id', companyId); } catch { /* best-effort */ }
    try { if (otherCompanyId) await admin.from('companies').delete().eq('id', otherCompanyId); } catch { /* best-effort */ }
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
