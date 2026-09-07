#!/usr/bin/env node
/**
 * scripts/selftest_worker_hours_report_auto_exit_anomaly.js
 *
 * Regressione per F-146 (AUDIT.md): la mappa METHOD_NOTE (duplicata in
 * services/workerHoursReport.js, routes/v1/reports.js, routes/v1/siteExport.js,
 * routes/v1/studio.js) marcava come anomalia solo 'admin_manual_correction' e
 * 'auto_exit_on_site_change' — non 'ladia_action' (uscita automatica del cron
 * services/missingExitCron.js per un turno dimenticato) né
 * 'auto_exit_stale_before_reopen' (guard anti-turno-fantasma,
 * migrations/161_punch_atomic_stale_entry_guard.sql). Un'uscita indovinata
 * dal sistema finiva quindi nel report "Ore Lavorate" (per consulenti del
 * lavoro/buste paga) identica a una timbratura reale, senza alcuna nota.
 *
 * Verifica dal vivo: seeding diretto di due coppie ENTRY/EXIT con questi due
 * method, chiamata reale a buildWorkerHoursReport() (la stessa funzione usata
 * dagli export PDF/XLSX), controllo che il campo anomaly sia valorizzato.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { buildWorkerHoursReport } = require('../services/workerHoursReport');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — uscite automatiche marcate come anomalia nel report ore (F-146)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('anomalia uscite automatiche nel report ore', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies').insert([{ name: 'TEST-F146-AutoExitAnomaly' }]).select('id').single();
  const { data: site } = await admin.from('sites').insert([{
    company_id: company.id, name: 'TEST-Cantiere-F146', address: 'Via Test', status: 'attivo',
  }]).select('id').single();
  const { data: worker } = await admin.from('workers').insert([{
    company_id: company.id, full_name: 'TEST-F146-Worker', fiscal_code: `F146${Date.now()}`.slice(0, 16).toUpperCase(),
    badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }]).select('id').single();

  const day = '2026-06-15';
  const rows = [
    // Giorno 1: entrata normale, uscita chiusa dal cron (turno dimenticato).
    { company_id: company.id, site_id: site.id, worker_id: worker.id, event_type: 'ENTRY', timestamp_server: `${day}T07:00:00+02:00`, method: 'personal_phone' },
    { company_id: company.id, site_id: site.id, worker_id: worker.id, event_type: 'EXIT',  timestamp_server: `${day}T18:00:00+02:00`, method: 'ladia_action' },
    // Giorno 2: entrata normale, uscita chiusa dal guard anti-turno-fantasma.
    { company_id: company.id, site_id: site.id, worker_id: worker.id, event_type: 'ENTRY', timestamp_server: `2026-06-16T07:00:00+02:00`, method: 'personal_phone' },
    { company_id: company.id, site_id: site.id, worker_id: worker.id, event_type: 'EXIT',  timestamp_server: `2026-06-16T16:00:00+02:00`, method: 'auto_exit_stale_before_reopen' },
  ];
  const { error: seedErr } = await admin.from('presence_logs').insert(rows);
  check('coppie ENTRY/EXIT di test seminate', !seedErr, seedErr);

  try {
    const report = await buildWorkerHoursReport(site.id, company.id, '2026-06-15', '2026-06-16', worker.id);
    const w = report.workers?.find(x => x.info?.id === worker.id) || report.workers?.[0];
    check('report generato con il lavoratore di test', !!w, report);

    const allEntries = (w?.days || []).flatMap(d => d.entries || []);
    check('due coppie presenti nel report', allEntries.length === 2, allEntries);

    const ladiaEntry = allEntries.find(e => e.exit_time === '18:00');
    check("uscita 'ladia_action' marcata come anomalia, non un dato pulito indistinguibile", !!ladiaEntry?.anomaly, ladiaEntry);

    const staleEntry = allEntries.find(e => e.exit_time === '16:00');
    check("uscita 'auto_exit_stale_before_reopen' marcata come anomalia", !!staleEntry?.anomaly, staleEntry);
  } finally {
    await admin.from('presence_logs').delete().eq('worker_id', worker.id);
    await admin.from('workers').delete().eq('id', worker.id);
    await admin.from('sites').delete().eq('id', site.id);
    await admin.from('companies').delete().eq('id', company.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
