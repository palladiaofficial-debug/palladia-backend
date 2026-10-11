#!/usr/bin/env node
/**
 * scripts/selftest_scan_identify_impresa.js — F-336 (AUDIT.md del frontend).
 *
 * QR del cantiere: un codice fiscale sconosciuto NON deve diventare un
 * dipendente dell'impresa se la persona non ha detto di essere dell'impresa.
 * Prima di F-336 POST /scan/identify creava sempre una riga in `workers`, così
 * l'operaio di un subappaltatore finiva in Organico, foglio ore e buste paga.
 *  - senza `impresa`: 400 IMPRESA_REQUIRED, nessun lavoratore creato;
 *  - impresa di un subappaltatore: 409 IMPRESA_SUBAPPALTATORE, nessun lavoratore;
 *  - impresa = 'own': come prima (lavoratore creato, consenso da dare);
 *  - un dipendente già registrato non deve scegliere niente (flusso invariato).
 */
'use strict';
require('dotenv').config();
const express = require('express');
const supabase = require('../lib/supabase');
const { signQrToken } = require('../routes/v1/qr');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}
const T = `TEST-F336-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-336 — QR del cantiere: chi non è dell\'impresa non diventa dipendente\x1b[0m');
  const app = express(); app.use(express.json()); app.set('trust proxy', true);
  app.use('/api/v1', require('../routes/v1/scan'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const post = async (body) => { const r = await fetch(`${base}/scan/identify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  const company = await ins('companies', { name: T });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-A`, address: 'Via 1', status: 'attivo' });
    const sub = await ins('subcontractors', { company_id: company.id, company_name: `${T} Edil Rossi` });
    await ins('site_subcontractors', { company_id: company.id, site_id: site.id, subcontractor_id: sub.id });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const qr = { worksite_id: site.id, t: signQrToken(site.id, exp), exp };
    const workersCount = async () => (await supabase.from('workers').select('id', { count: 'exact', head: true }).eq('company_id', company.id)).count;

    const cfSub = `SUBRSS80A01${stamp.slice(0, 4)}X`.slice(0, 16).toUpperCase();
    const r1 = await post({ ...qr, fiscal_code: cfSub, full_name: 'Ion Popescu' });
    check('codice fiscale sconosciuto senza impresa: 400 IMPRESA_REQUIRED', r1.status === 400 && r1.body.error === 'IMPRESA_REQUIRED', r1);
    check('…e nessun lavoratore creato nell\'impresa', await workersCount() === 0, await workersCount());
    check('modulo presenze imprese spento: si sceglie solo tra la nostra impresa',
      Array.isArray(r1.body.imprese) && r1.body.imprese.length === 1 && r1.body.imprese[0].id === 'own', r1.body.imprese);
    await ins('company_feature_flags', { company_id: company.id, feature: 'presenze_imprese', enabled: true });
    const r1b = await post({ ...qr, fiscal_code: cfSub, full_name: 'Ion Popescu' });
    check('modulo acceso: la risposta elenca la nostra impresa e il subappaltatore del cantiere',
      r1b.status === 400 && r1b.body.imprese?.some(i => i.id === sub.id) && r1b.body.imprese?.some(i => i.id === 'own'), r1b.body);

    const r2 = await post({ ...qr, fiscal_code: cfSub, full_name: 'Ion Popescu', impresa: sub.id });
    check('impresa = subappaltatore: 409 IMPRESA_SUBAPPALTATORE', r2.status === 409 && r2.body.error === 'IMPRESA_SUBAPPALTATORE', r2);
    check('…e nessun lavoratore creato', await workersCount() === 0, await workersCount());

    const cfOwn = `OWNBNC80A01${stamp.slice(0, 4)}Y`.slice(0, 16).toUpperCase();
    const r3 = await post({ ...qr, fiscal_code: cfOwn, full_name: 'Mario Bianchi', impresa: 'own' });
    check('impresa = la nostra: lavoratore creato come prima, consenso da dare', r3.status === 200 && r3.body.requires_privacy_consent === true && !!r3.body.worker_id, r3);
    check('…un solo lavoratore nell\'impresa', await workersCount() === 1, await workersCount());

    const r4 = await post({ ...qr, fiscal_code: cfOwn });
    check('dipendente già registrato: nessuna scelta dell\'impresa richiesta', r4.status === 200 && r4.body.worker_id === r3.body.worker_id, r4);
  } finally {
    server.close();
    await supabase.from('worker_device_sessions').delete().eq('company_id', company.id);
    await supabase.from('worksite_workers').delete().eq('company_id', company.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('company_feature_flags').delete().eq('company_id', company.id);
    await supabase.from('site_subcontractors').delete().eq('company_id', company.id);
    await supabase.from('subcontractors').delete().eq('company_id', company.id);
    await supabase.from('sites').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
