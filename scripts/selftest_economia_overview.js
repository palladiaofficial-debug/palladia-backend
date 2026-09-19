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
 * 5) previsione_30gg (azienda) conta solo dati certi: SAL con
 *    data_pagamento_prevista entro 30gg e non ancora pagati, spese
 *    ricorrenti attive con prossima occorrenza entro 30gg — mai una
 *    scadenza stimata su fatture/spese che non ce l'hanno davvero.
 * 6) previsione_30gg include anche le fatture con una vera data_scadenza
 *    (migrazione 227, estratta ora dall'XML FatturaPA — vedi
 *    lib/fatturaPaXmlParser.js) entro 30gg e non pagate; esclude quelle
 *    oltre 30gg o già pagate, anche se restano comunque in "Da pagare".
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

function isoOffset(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }

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
  const costIds = [], expenseIds = [], salIds = [], recurringIds = [];

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

    // ── Previsione di cassa 30gg — solo dati certi (scelta esplicita del
    // titolare dopo il confronto con Pillar): un SAL con scadenza entro 30gg
    // conta, uno oltre no, uno già pagato no anche se la scadenza è vicina;
    // una spesa ricorrente attiva con prossima occorrenza entro 30gg conta,
    // una disattivata no.
    const { data: sal3 } = await admin.from('site_sal_history').insert({
      company_id: companyId, site_id: siteId, sal_number: 3, importo_maturato: 7000, totale_costi: 0,
      data_pagamento_prevista: isoOffset(10),
    }).select().single();
    salIds.push(sal3.id);
    const { data: sal4 } = await admin.from('site_sal_history').insert({
      company_id: companyId, site_id: siteId, sal_number: 4, importo_maturato: 20000, totale_costi: 0,
      data_pagamento_prevista: isoOffset(60),
    }).select().single();
    salIds.push(sal4.id);
    const { data: sal5 } = await admin.from('site_sal_history').insert({
      company_id: companyId, site_id: siteId, sal_number: 5, importo_maturato: 3000, totale_costi: 0,
      data_pagamento_prevista: isoOffset(5), pagato_il: isoOffset(-1),
    }).select().single();
    salIds.push(sal5.id);

    const todayDay = new Date().getDate();
    const { data: rec1 } = await admin.from('company_recurring_expenses').insert({
      company_id: companyId, amount: 1200, description: 'TEST affitto', day_of_month: Math.min(28, todayDay),
    }).select().single();
    recurringIds.push(rec1.id);
    const { data: rec2 } = await admin.from('company_recurring_expenses').insert({
      company_id: companyId, amount: 999, description: 'TEST assicurazione disattivata', day_of_month: Math.min(28, todayDay), is_active: false,
    }).select().single();
    recurringIds.push(rec2.id);

    // Fatture importate con una vera scadenza dichiarata nell'XML (F-216,
    // seguito al confronto con Pillar) — mai una stima, solo data_scadenza
    // reale (migrazione 227): una entro 30gg conta, una oltre no, una già
    // pagata anche se la scadenza è vicina no.
    const { data: inv1 } = await admin.from('company_expenses').insert({
      company_id: companyId, site_id: null, amount: 640, description: 'TEST fattura con scadenza entro 30gg',
      source: 'manual', data_scadenza: isoOffset(15),
    }).select().single();
    expenseIds.push(inv1.id);
    const { data: inv2 } = await admin.from('company_expenses').insert({
      company_id: companyId, site_id: null, amount: 2000, description: 'TEST fattura con scadenza oltre 30gg',
      source: 'manual', data_scadenza: isoOffset(45),
    }).select().single();
    expenseIds.push(inv2.id);
    const { data: inv3 } = await admin.from('company_expenses').insert({
      company_id: companyId, site_id: null, amount: 300, description: 'TEST fattura con scadenza vicina ma già pagata',
      source: 'manual', data_scadenza: isoOffset(3), pagato_il: isoOffset(-1),
    }).select().single();
    expenseIds.push(inv3.id);

    // Spesa generale (site_id NULL) — non deve toccare il cantiere, deve entrare nel totale azienda.
    const { data: e1 } = await admin.from('company_expenses').insert({
      company_id: companyId, site_id: null, amount: 450, description: 'TEST spesa generale', category: 'altro',
    }).select().single();
    expenseIds.push(e1.id);

    // ── Verifiche ───────────────────────────────────────────────────────
    const siteOverview = await apiCall(jwt, companyId, 'GET', `/sites/${siteId}/economia-overview`);
    check('Overview cantiere -> 200', siteOverview.status === 200, siteOverview);
    check('da_incassare = 42.000€ (sal1+sal3+sal4 non pagati; sal2 e sal5 pagati non contano)', siteOverview.body?.da_incassare?.totale === 42000, siteOverview.body?.da_incassare);
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
    check('Overview azienda: da_incassare = 42.000€', companyOverview.body?.da_incassare?.totale === 42000, companyOverview.body?.da_incassare);
    // 3.090€ spese generali = 450 (spesa generale) + 640 (fattura entro 30gg) +
    // 2.000 (fattura oltre 30gg, ma è comunque "da pagare" oggi — la finestra
    // dei 30gg vale solo per previsione_30gg, non per il totale aperto) — la
    // fattura già pagata (inv3) non conta mai in un "aperto".
    check('Overview azienda: da_pagare = 15.290€ (12.200 cantiere + 3.090 spese generali)', companyOverview.body?.da_pagare?.totale === 15290, companyOverview.body?.da_pagare);
    check('Overview azienda: spese generali isolate = 3.090€', companyOverview.body?.da_pagare?.spese_generali === 3090, companyOverview.body?.da_pagare);
    const rigaCantiere = (companyOverview.body?.cantieri || []).find(c => c.site_id === siteId);
    check('Overview azienda: il cantiere appare nella lista con gli stessi numeri (42.000 / 12.200)', !!rigaCantiere && rigaCantiere.da_incassare === 42000 && rigaCantiere.da_pagare === 12200, rigaCantiere);

    // ── Previsione 30gg (solo dati certi) ──────────────────────────────────
    const prev = companyOverview.body?.previsione_30gg;
    check('previsione_30gg.in_entrata = 7.000€ (solo il SAL entro 30gg, non pagato)', prev?.in_entrata === 7000, prev);
    check('previsione_30gg.in_entrata esclude il SAL oltre 30gg (20.000€ a +60gg)', prev?.in_entrata !== 27000, prev);
    check('previsione_30gg.in_entrata esclude il SAL già pagato anche se la scadenza è vicina (3.000€)', prev?.in_entrata !== 10000, prev);
    check('previsione_30gg.in_uscita_certa = 1.840€ (1.200 ricorrente + 640 fattura con scadenza entro 30gg)', prev?.in_uscita_certa === 1840, prev);
    check('previsione_30gg.in_uscita_certa esclude la fattura con scadenza oltre 30gg (2.640€ sarebbe sbagliato)', prev?.in_uscita_certa !== 3840, prev);
    check('previsione_30gg.in_uscita_certa esclude la fattura già pagata anche con scadenza vicina (300€)', prev?.in_uscita_certa !== 2140, prev);

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
    if (recurringIds.length) await admin.from('company_recurring_expenses').delete().in('id', recurringIds);
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
