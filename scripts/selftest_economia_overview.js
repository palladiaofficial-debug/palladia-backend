#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_economia_overview.js
 *
 * F-215 (AUDIT.md): pagina "Economia" unificata — GET /economia-overview
 * (azienda) e GET /sites/:siteId/economia-overview (cantiere). Verifica dal
 * vivo, HTTP reale contro produzione, azienda/sito/worker isolati creati e
 * ripuliti da questo stesso test (stesso pattern di
 * selftest_economia_overview_api.js) — nessun rischio di toccare dati veri.
 *
 * Scenario costruito a mano con importi noti, per verificare che:
 * 1) da_incassare conta solo i SAL emessi NON ancora pagati dal cliente
 *    (pagato_il IS NULL) — non il maturato totale.
 * 2) da_pagare conta le fatture/spese aperte (pagato_il IS NULL) ma MAI un
 *    "acconto" (per definizione già dato) né un DDT senza importo.
 * 3) il saldo verso un subappaltatore (budget pattuito − acconti dati) si
 *    somma correttamente a da_pagare, senza doppio conteggio con le sue
 *    eventuali fatture (escluse a monte).
 * 4) una spesa generale (site_id NULL) non tocca il cantiere ma entra nel
 *    totale azienda.
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

async function apiCall(jwt, companyId, method, urlPath) {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method, headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

async function main() {
  console.log('\nPalladia — Economia unificata: da_incassare / da_pagare (F-215)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY,    { auth: { autoRefreshToken: false, persistSession: false } });

  const email = `test-economia-unificata-${Date.now()}@palladia-test.internal`;
  let companyId, siteId, userId, subcontractorId;
  const costIds = [], expenseIds = [], salIds = [];

  try {
    const { data: company } = await admin.from('companies').insert({ name: 'TEST-EconomiaUnificata' }).select().single();
    companyId = company.id;
    const { data: site } = await admin.from('sites').insert({
      company_id: companyId, name: 'TEST site unificata', status: 'attivo', address: 'Via Test Unificata',
    }).select().single();
    siteId = site.id;

    const { data: userRes, error: userErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    check('Utente di test creato', !userErr && userRes?.user, userErr);
    userId = userRes.user.id;
    await admin.from('company_users').insert({ company_id: companyId, user_id: userId, role: 'owner' });
    const jwt = await sessionFor(admin, anon, email);
    check('Sessione JWT ottenuta', !!jwt);

    // ── Scenario ────────────────────────────────────────────────────────
    // SAL: 15.000€ emesso non pagato, 5.000€ emesso e già pagato (non deve contare).
    const { data: sal1 } = await admin.from('site_sal_history').insert({
      company_id: companyId, site_id: siteId, sal_number: 1, importo_maturato: 15000, totale_costi: 0,
    }).select().single();
    salIds.push(sal1.id);
    const { data: sal2 } = await admin.from('site_sal_history').insert({
      company_id: companyId, site_id: siteId, sal_number: 2, importo_maturato: 5000, totale_costi: 0, pagato_il: '2026-09-01',
    }).select().single();
    salIds.push(sal2.id);

    // Costi: una fattura aperta (3.200€), un DDT senza importo (non deve mai contare),
    // un acconto NON a un subappaltatore (mai "da pagare" per definizione).
    const { data: c1 } = await admin.from('site_costs').insert({
      company_id: companyId, site_id: siteId, descrizione: 'Fattura aperta', importo: 3200, tipo: 'fattura',
    }).select().single();
    costIds.push(c1.id);
    const { data: c2 } = await admin.from('site_costs').insert({
      company_id: companyId, site_id: siteId, descrizione: 'DDT senza importo', importo: null, tipo: 'ddt',
    }).select().single();
    costIds.push(c2.id);
    const { data: c3 } = await admin.from('site_costs').insert({
      company_id: companyId, site_id: siteId, descrizione: 'Acconto a fornitore', importo: 900, tipo: 'acconto',
    }).select().single();
    costIds.push(c3.id);

    // Subappaltatore: budget 11.000€, acconto già dato 2.000€ → saldo 9.000€.
    const { data: sub } = await admin.from('subcontractors').insert({ company_id: companyId, company_name: 'TEST AYAT SRLS' }).select().single();
    subcontractorId = sub.id;
    await admin.from('site_subcontractors').insert({ company_id: companyId, site_id: siteId, subcontractor_id: subcontractorId, budget_totale: 11000 });
    const { data: c4 } = await admin.from('site_costs').insert({
      company_id: companyId, site_id: siteId, descrizione: 'Acconto AYAT', importo: 2000, tipo: 'acconto', subcontractor_id: subcontractorId,
    }).select().single();
    costIds.push(c4.id);

    // Spesa generale (site_id NULL) — non deve toccare il cantiere, deve entrare nel totale azienda.
    const { data: e1 } = await admin.from('company_expenses').insert({
      company_id: companyId, site_id: null, amount: 450, description: 'TEST spesa generale', category: 'altro',
    }).select().single();
    expenseIds.push(e1.id);

    // ── Verifiche ───────────────────────────────────────────────────────
    const siteOverview = await apiCall(jwt, companyId, 'GET', `/sites/${siteId}/economia-overview`);
    check('Overview cantiere -> 200', siteOverview.status === 200, siteOverview);
    check('da_incassare = 15.000€ (il SAL pagato non conta)', siteOverview.body?.da_incassare?.totale === 15000, siteOverview.body?.da_incassare);
    check('da_pagare.fatture = 3.200€ (l\'acconto e il DDT non contano)', siteOverview.body?.da_pagare?.fatture === 3200, siteOverview.body?.da_pagare);
    check('da_pagare.subappalti = 9.000€ (11.000 − 2.000 già dati)', siteOverview.body?.da_pagare?.subappalti === 9000, siteOverview.body?.da_pagare);
    check('da_pagare.totale = 12.200€ (3.200 fatture + 9.000 subappalto)', siteOverview.body?.da_pagare?.totale === 12200, siteOverview.body?.da_pagare);
    check('subappaltatori elenca AYAT con saldo 9.000€', siteOverview.body?.da_pagare?.subappaltatori?.[0]?.saldo_da_erogare === 9000, siteOverview.body?.da_pagare?.subappaltatori);
    check('has_contratto = false (nessun budget impostato sul cantiere di test)', siteOverview.body?.site?.has_contratto === false, siteOverview.body?.site);
    check('site.budget_totale = null (per precompilare il form senza inventare uno zero)', siteOverview.body?.site?.budget_totale === null, siteOverview.body?.site);

    const movimenti = siteOverview.body?.movimenti || [];
    check('movimenti include il DDT con importo null (mai "0")', movimenti.some(m => m.tipo === 'ddt' && m.importo === null), movimenti);
    check('movimenti include l\'acconto a fornitore già marcato pagato=true', movimenti.some(m => m.tipo === 'acconto' && m.controparte === null && m.pagato === true), movimenti);
    check('movimenti include l\'acconto AYAT come acconto_subappalto, pagato=true', movimenti.some(m => m.tipo === 'acconto_subappalto' && m.controparte === 'TEST AYAT SRLS' && m.pagato === true), movimenti);
    check('movimenti include il SAL aperto (n.1) con pagato=false', movimenti.some(m => m.tipo === 'sal' && m.descrizione === 'SAL n. 1' && m.pagato === false), movimenti);
    check('movimenti include la fattura aperta con pagato=false', movimenti.some(m => m.tipo === 'fattura' && m.pagato === false && m.importo === 3200), movimenti);

    const companyOverview = await apiCall(jwt, companyId, 'GET', '/economia-overview');
    check('Overview azienda -> 200', companyOverview.status === 200, companyOverview);
    check('Overview azienda: da_incassare = 15.000€', companyOverview.body?.da_incassare?.totale === 15000, companyOverview.body?.da_incassare);
    check('Overview azienda: da_pagare = 12.650€ (12.200 cantiere + 450 spesa generale)', companyOverview.body?.da_pagare?.totale === 12650, companyOverview.body?.da_pagare);
    check('Overview azienda: spese generali isolate = 450€', companyOverview.body?.da_pagare?.spese_generali === 450, companyOverview.body?.da_pagare);
    const rigaCantiere = (companyOverview.body?.cantieri || []).find(c => c.site_id === siteId);
    check('Overview azienda: il cantiere appare nella lista con gli stessi numeri (15.000 / 12.200)', !!rigaCantiere && rigaCantiere.da_incassare === 15000 && rigaCantiere.da_pagare === 12200, rigaCantiere);

    // ── "Segna pagata" su una spesa generale (F-215: pagato_il ora accettato
    // da PUT /expenses/:id, mancava dallo schema di validazione) ──────────
    {
      const r = await fetch(`${API_BASE}/expenses/${e1.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pagato_il: '2026-09-19' }),
      });
      const body = await r.json().catch(() => null);
      check('PUT /expenses/:id accetta pagato_il -> 200', r.status === 200, { status: r.status, body });
      check('pagato_il salvato davvero in DB', body?.pagato_il === '2026-09-19', body);
    }

    // ── Guardiano cross-tenant ────────────────────────────────────────────
    const { data: otherCompany } = await admin.from('companies').insert({ name: 'TEST-EconomiaUnificata-Other' }).select().single();
    const crossCall = await apiCall(jwt, otherCompany.id, 'GET', `/sites/${siteId}/economia-overview`);
    check('Un\'altra company non vede il cantiere (403/404)', crossCall.status === 403 || crossCall.status === 404, crossCall);
    await admin.from('companies').delete().eq('id', otherCompany.id);

  } finally {
    if (salIds.length) await admin.from('site_sal_history').delete().in('id', salIds);
    if (costIds.length) await admin.from('site_costs').delete().in('id', costIds);
    if (expenseIds.length) await admin.from('company_expenses').delete().in('id', expenseIds);
    if (subcontractorId) {
      await admin.from('site_subcontractors').delete().eq('subcontractor_id', subcontractorId);
      await admin.from('subcontractors').delete().eq('id', subcontractorId);
    }
    if (siteId) await admin.from('sites').delete().eq('id', siteId);
    if (userId) { await admin.from('company_users').delete().eq('user_id', userId); await admin.auth.admin.deleteUser(userId); }
    if (companyId) await admin.from('companies').delete().eq('id', companyId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
