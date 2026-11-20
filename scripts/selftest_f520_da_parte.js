#!/usr/bin/env node
/**
 * scripts/selftest_f520_da_parte.js — AUDIT.md F-520 (2026-11-20)
 *
 * Inventario del 20/11: il titolare ha messo «da parte» 6 voci. Da parte =
 * spente per TUTTE le imprese, anche per chi ha una riga accesa in
 * company_feature_flags (MSC aveva da_pagare acceso) e anche per la master
 * company. Si riaccendono solo con FEATURE_<NOME>_DEFAULT=true.
 *
 * Il test fallisce se una di queste torna raggiungibile:
 *   - i flag (flagsPer / isFeatureEnabled), con righe accese e company master;
 *   - «Pronta a lavorare»: GET /pronto e il link pubblico /documenti-per/:token;
 *   - area di chi paga le buste: GET /payer/:token/payslips;
 *   - documenti delle imprese per email: GET /imprese/email e ricevi().
 */
'use strict';
require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const jwtPath = path.join(__dirname, '../middleware/verifyJwt.js');
require.cache[jwtPath] = { id: jwtPath, filename: jwtPath, loaded: true, exports: {
  verifySupabaseJwt: (req, _res, next) => { req.companyId = req.get('x-test-company'); req.userRole = 'owner'; req.user = { id: null }; next(); },
} };

const DA_PARTE = ['da_pagare', 'estratto_conto', 'quanto_rende', 'email_ingest_manual_forward_setup',
  'pagamenti_buste', 'pronta_a_lavorare', 'documenti_per_email'];
for (const f of DA_PARTE) delete process.env[`FEATURE_${f.toUpperCase()}_DEFAULT`];

const supabase = require('../lib/supabase');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-520 — le voci «da parte» restano spente\x1b[0m');
  const co = await ins('companies', { name: `TEST-F520-${Date.now()}` });
  // la company è anche master: da parte vale anche lì
  process.env.MASTER_COMPANY_IDS = [process.env.MASTER_COMPANY_IDS, co.id].filter(Boolean).join(',');
  const ff = require('../lib/featureFlags');
  const impreseEmail = require('../lib/impreseEmail');
  const P = require('../lib/prontoSubappalto');

  const app = express(); app.use(express.json());
  app.use('/api/v1', require('../routes/v1/pronto'));
  app.use('/api/v1', require('../routes/v1/payerArea'));
  app.use('/api/v1', require('../routes/v1/impreseCarica'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const get = async (url) => { const r = await fetch(base + url, { headers: { 'x-test-company': co.id } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  let payerId = null, pacchettoId = null;
  try {
    // righe accese per l'azienda, come aveva MSC per da_pagare
    await supabase.from('company_feature_flags').insert(
      [...DA_PARTE, 'subappaltatori'].map(feature => ({ company_id: co.id, feature, enabled: true })));

    // 1. Flag
    const flags = await ff.flagsPer(co.id);
    for (const f of DA_PARTE) check(`flagsPer: ${f} spento anche con la riga accesa e da master`, flags[f] === false, flags[f]);
    for (const f of DA_PARTE) check(`isFeatureEnabled: ${f} spento`, (await ff.isFeatureEnabled(co.id, f)) === false);
    check('subappaltatori (Imprese, si tiene) resta acceso con la riga', flags.subappaltatori === true, flags.subappaltatori);

    // 2. «Pronta a lavorare»
    const pronto = await get('/pronto');
    check('GET /pronto → 404', pronto.status === 404, pronto);
    const pac = await P.crea(co.id, null, { destinatario: 'Impresa di prova' });
    pacchettoId = pac.id;
    const tok = pac.url.split('/').pop();
    const pub = await get(`/documenti-per/${tok}`);
    check('il link /documenti-per/:token non si apre più (404)', pub.status === 404, pub);

    // 3. Area di chi paga le buste
    const token = crypto.randomBytes(32).toString('hex');
    const sess = await ins('payslip_payer_sessions', {
      company_id: co.id, email: 'f520@example.invalid',
      token_hash: crypto.createHash('sha256').update(token).digest('hex'),
      expires_at: new Date(Date.now() + 864e5).toISOString(),
    });
    payerId = sess.id;
    const payer = await get(`/payer/${token}/payslips`);
    check('il link di chi paga le buste non si apre più (404)', payer.status === 404, payer);

    // 4. Documenti delle imprese per email
    const em = await get('/imprese/email');
    check('GET /imprese/email → 404, nessun indirizzo creato', em.status === 404 && !em.body.indirizzo, em);
    let { data: gia } = await supabase.from('imprese_email_indirizzi').select('token').eq('company_id', co.id).maybeSingle();
    const tokEmail = gia?.token || `${impreseEmail.PREFISSO}f520-${crypto.randomBytes(3).toString('hex')}`;
    if (!gia) await supabase.from('imprese_email_indirizzi').insert({ company_id: co.id, token: tokEmail });
    const r = await impreseEmail.ricevi({ token: tokEmail, da: 'x@example.invalid', oggetto: 'prova', files: [] });
    check('un\'email a documenti-… viene ignorata (esito spento)', r.esito === 'spento', r);
  } finally {
    server.close();
    if (payerId) await supabase.from('payslip_payer_sessions').delete().eq('id', payerId);
    if (pacchettoId) await supabase.from('pacchetti_documenti').delete().eq('id', pacchettoId);
    for (const t of ['imprese_email_indirizzi', 'company_feature_flags', 'payslip_payer_sessions', 'pacchetti_documenti']) await supabase.from(t).delete().eq('company_id', co.id);
    await supabase.from('companies').delete().eq('id', co.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(err => { console.error(err); process.exit(1); });
