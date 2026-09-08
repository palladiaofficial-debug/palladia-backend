#!/usr/bin/env node
/**
 * scripts/selftest_worker_hours_report_all_sites.js
 *
 * Regressione per F-151 (AUDIT.md): la pagina "Presenze & Report" bloccava
 * TUTTI e 4 gli export quando l'utente teneva il filtro su "Tutti i
 * cantieri" — tre dei quattro endpoint (Ore-PDF, Excel, CSV) erano bloccati
 * solo da una validazione applicativa (siteId obbligatorio in query string),
 * non da un vincolo strutturale. Questo test verifica che
 * buildWorkerHoursReport(), il cuore condiviso di PDF/XLSX/JSON "Ore
 * Lavorate", produca un report corretto quando siteId è null — aggregando
 * TUTTI i cantieri dell'azienda, con la config pausa pranzo risolta per
 * ciascun cantiere separatamente.
 *
 * Verifica dal vivo: due cantieri della stessa azienda, un lavoratore che
 * lavora in entrambi in giorni diversi, chiamata reale con siteId=null.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { buildWorkerHoursReport } = require('../services/workerHoursReport');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — export "Ore Lavorate" con tutti i cantieri, siteId=null (F-151)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('report ore su tutti i cantieri', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies').insert([{ name: 'TEST-F151-AllSites' }]).select('id').single();
  const { data: siteA } = await admin.from('sites').insert([{
    company_id: company.id, name: 'TEST-Cantiere-F151-A', address: 'Via Test A', status: 'attivo',
  }]).select('id').single();
  const { data: siteB } = await admin.from('sites').insert([{
    company_id: company.id, name: 'TEST-Cantiere-F151-B', address: 'Via Test B', status: 'attivo',
  }]).select('id').single();
  const { data: worker } = await admin.from('workers').insert([{
    company_id: company.id, full_name: 'TEST-F151-Worker', fiscal_code: `F151${Date.now()}`.slice(0, 16).toUpperCase(),
    badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }]).select('id').single();

  const rows = [
    // Giorno 1 al cantiere A: 4h
    { company_id: company.id, site_id: siteA.id, worker_id: worker.id, event_type: 'ENTRY', timestamp_server: '2026-06-15T08:00:00+02:00', method: 'personal_phone' },
    { company_id: company.id, site_id: siteA.id, worker_id: worker.id, event_type: 'EXIT',  timestamp_server: '2026-06-15T12:00:00+02:00', method: 'personal_phone' },
    // Giorno 2 al cantiere B: 3h
    { company_id: company.id, site_id: siteB.id, worker_id: worker.id, event_type: 'ENTRY', timestamp_server: '2026-06-16T08:00:00+02:00', method: 'personal_phone' },
    { company_id: company.id, site_id: siteB.id, worker_id: worker.id, event_type: 'EXIT',  timestamp_server: '2026-06-16T11:00:00+02:00', method: 'personal_phone' },
  ];
  const { error: seedErr } = await admin.from('presence_logs').insert(rows);
  check('coppie ENTRY/EXIT di test seminate su 2 cantieri distinti', !seedErr, seedErr);

  try {
    // siteId = null → "tutti i cantieri" dell'azienda
    const report = await buildWorkerHoursReport(null, company.id, '2026-06-15', '2026-06-16', worker.id);

    check('report generato senza errore con siteId=null', !!report, report);
    check('single_site = false in modalità "tutti i cantieri"', report.single_site === false, report.single_site);
    check('site.name = "Tutti i cantieri" quando siteId è null', report.site?.name === 'Tutti i cantieri', report.site);

    const w = report.workers.find(x => x.id === worker.id);
    check('lavoratore presente nel report aggregato', !!w, report.workers);
    check('ore totali sommate su entrambi i cantieri (4h + 3h = 7h = 420min)', w?.total_minutes === 420, w);
    check('2 giornate distinte nel report (una per cantiere)', w?.total_days === 2, w);

    const siteNames = new Set((w?.days || []).map(d => d.site_name));
    check('entrambi i cantieri rappresentati nei day-entry (site_name distinto per giorno)',
      siteNames.has('TEST-Cantiere-F151-A') && siteNames.has('TEST-Cantiere-F151-B'), [...siteNames]);

    // Confronto: lo stesso lavoratore filtrato SOLO sul cantiere A deve
    // vedere solo le sue 4h — la modalità "tutti i cantieri" non deve
    // inquinare l'export a singolo cantiere.
    const reportSingle = await buildWorkerHoursReport(siteA.id, company.id, '2026-06-15', '2026-06-16', worker.id);
    const wSingle = reportSingle.workers.find(x => x.id === worker.id);
    check('modalità singolo cantiere (A) invariata: solo le 4h di quel cantiere',
      wSingle?.total_minutes === 240 && reportSingle.single_site === true, wSingle);
  } finally {
    await admin.from('presence_logs').delete().eq('worker_id', worker.id);
    await admin.from('workers').delete().eq('id', worker.id);
    await admin.from('sites').delete().in('id', [siteA.id, siteB.id]);
    await admin.from('companies').delete().eq('id', company.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
