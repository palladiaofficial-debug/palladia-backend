#!/usr/bin/env node
/**
 * scripts/selftest_presence_report_lunch_break.js
 *
 * Regressione per F-152 (AUDIT.md): buildDailyPresenceSummary() (usata dal
 * PDF "Registro Presenze Cantiere", l'unico export che resta legato a un
 * singolo cantiere per motivi legali/ASL — vedi F-151) deve applicare la
 * stessa detrazione pausa pranzo del report Ore Lavorate, non solo quello.
 *
 * Verifica dal vivo: cantiere con override pausa pranzo, turno unico
 * continuo sopra soglia, chiamata reale a buildDailyPresenceSummary().
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { buildDailyPresenceSummary } = require('../services/presenceReport');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — detrazione pausa pranzo nel Registro Presenze (F-152)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('detrazione pausa pranzo Registro Presenze', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies')
    .insert([{ name: 'TEST-F152-Registro' }]).select('id').single();
  const { data: site } = await admin.from('sites').insert([{
    company_id: company.id, name: 'TEST-Cantiere-F152-Registro', address: 'Via Test', status: 'attivo',
    lunch_break_minutes: 30, lunch_break_threshold_hours: 6,
  }]).select('id').single();
  const { data: worker } = await admin.from('workers').insert([{
    company_id: company.id, full_name: 'TEST-F152-RegistroWorker', fiscal_code: `F152R${Date.now()}`.slice(0, 16).toUpperCase(),
    badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }]).select('id').single();

  const rows = [
    // Stesso scenario segnalato dall'utente: 07:37 -> 17:01 (9h24m raw)
    { company_id: company.id, site_id: site.id, worker_id: worker.id, event_type: 'ENTRY', timestamp_server: '2026-06-15T07:37:00+02:00', method: 'personal_phone' },
    { company_id: company.id, site_id: site.id, worker_id: worker.id, event_type: 'EXIT',  timestamp_server: '2026-06-15T17:01:00+02:00', method: 'personal_phone' },
  ];
  const { error: seedErr } = await admin.from('presence_logs').insert(rows);
  check('coppia ENTRY/EXIT di test seminata', !seedErr, seedErr);

  try {
    const report = await buildDailyPresenceSummary(site.id, company.id, '2026-06-15', '2026-06-15');
    check('report generato senza errore', !!report, report);
    const row = report.rows?.find(r => r.worker_name === 'TEST-F152-RegistroWorker');
    check('riga del lavoratore presente', !!row, report.rows);
    check('9h24m raw − 30m pausa pranzo = 8h54m (8.9h)', row?.hours_total === 8.9, row);
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
