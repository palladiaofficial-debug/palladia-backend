#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_manual_ddt_no_amount.js
 *
 * F-220 (AUDIT.md): POST /api/v1/sites/:siteId/costs (creazione manuale di
 * una spesa cantiere, usata dal form "Aggiungi spesa" di
 * EconomiaUnifiedSummary.tsx) imponeva un `importo` obbligatorio per
 * QUALSIASI tipo, DDT incluso — mentre il flusso badge trasportatori
 * (routes/v1/badgeDdt.js, F-213) e la colonna DB (site_costs.importo
 * nullable, migrazione 221) trattano esplicitamente un DDT come un
 * documento che quasi mai ha un prezzo al momento della consegna. Trovato
 * durante un test end-to-end reale del controllo economico su un cantiere,
 * non da un audit dedicato.
 *
 * Verifica dal vivo, HTTP reale contro produzione, azienda/sito isolati
 * creati e ripuliti da questo stesso test.
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

async function postCost(jwt, companyId, siteId, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(`${API_BASE}/sites/${siteId}/costs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
    body: fd,
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

async function main() {
  console.log('\nPalladia — Spesa manuale DDT senza importo (F-220)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    skip('suite', 'SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY mancanti');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY,    { auth: { autoRefreshToken: false, persistSession: false } });

  const email = `test-manual-ddt-${Date.now()}@palladia-test.internal`;
  let companyId, siteId, userId;
  const costIds = [];

  try {
    const { data: company } = await admin.from('companies').insert({ name: 'TEST-ManualDdtNoAmount' }).select().single();
    companyId = company.id;
    const { data: site } = await admin.from('sites').insert({
      company_id: companyId, name: 'TEST site DDT manuale', status: 'attivo', address: 'Via Test DDT',
    }).select().single();
    siteId = site.id;

    const { data: userRes, error: userErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    check('Utente di test creato', !userErr && userRes?.user, userErr);
    userId = userRes.user.id;
    await admin.from('company_users').insert({ company_id: companyId, user_id: userId, role: 'owner' });
    const jwt = await sessionFor(admin, anon, email);
    check('Sessione JWT ottenuta', !!jwt);

    // ── Un DDT manuale senza importo deve essere accettato, importo NULL ────
    const r1 = await postCost(jwt, companyId, siteId, {
      descrizione: 'DDT manuale senza prezzo', tipo: 'ddt', categoria: 'Materiali',
    });
    check('POST /costs (tipo=ddt, senza importo) -> 201', r1.status === 201, r1.body);
    check('importo salvato NULL, mai un valore inventato', r1.body?.importo === null, r1.body);
    if (r1.body?.id) costIds.push(r1.body.id);

    // ── Una fattura senza importo resta rifiutata (comportamento invariato) ──
    const r2 = await postCost(jwt, companyId, siteId, {
      descrizione: 'Fattura senza importo', tipo: 'fattura', categoria: 'Materiali',
    });
    check('POST /costs (tipo=fattura, senza importo) -> 400 MISSING_IMPORTO', r2.status === 400 && r2.body?.error === 'MISSING_IMPORTO', r2.body);

    // ── Un DDT manuale CON importo (es. arrivato insieme al prezzo) resta possibile ──
    const r3 = await postCost(jwt, companyId, siteId, {
      descrizione: 'DDT manuale con prezzo noto', tipo: 'ddt', categoria: 'Materiali', importo: '450.50',
    });
    check('POST /costs (tipo=ddt, con importo) -> 201, importo salvato', r3.status === 201 && r3.body?.importo === 450.5, r3.body);
    if (r3.body?.id) costIds.push(r3.body.id);

    // ── Il DDT senza importo non deve mai contare come "da pagare" ───────────
    const overview = await fetch(`${API_BASE}/sites/${siteId}/economia-overview`, {
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
    }).then(r => r.json());
    check('da_pagare.fatture = 450.5€ (solo il DDT CON importo; quello senza non conta)', overview?.da_pagare?.fatture === 450.5, overview?.da_pagare);
    check('movimenti include il DDT senza importo con importo null (mai "0")', (overview?.movimenti || []).some(m => m.tipo === 'ddt' && m.importo === null), overview?.movimenti);

  } finally {
    if (costIds.length) await admin.from('site_costs').delete().in('id', costIds);
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
