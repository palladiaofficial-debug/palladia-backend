#!/usr/bin/env node
/**
 * scripts/selftest_worker_hours_report_lunch_break.js
 *
 * Regressione per F-152 (AUDIT.md): buildWorkerHoursReport() (usata da
 * PDF/XLSX "Ore Lavorate") deve applicare la detrazione pausa pranzo
 * configurata — override per cantiere se impostato, altrimenti default
 * azienda (migrations/195) — e MAI detrarre due volte quando il lavoratore
 * ha già timbrato una pausa reale (2 coppie ENTRY/EXIT nello stesso giorno).
 *
 * Verifica dal vivo: seeding reale (company con default 45min/5h, cantiere A
 * senza override → eredita, cantiere B con override 20min/4h), chiamata
 * reale a buildWorkerHoursReport(), controllo sulle ore nette restituite.
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
  console.log('\nPalladia regression — detrazione pausa pranzo nel report Ore Lavorate (F-152)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('detrazione pausa pranzo report ore', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: company } = await admin.from('companies')
    .insert([{ name: 'TEST-F152-LunchBreak', lunch_break_minutes: 45, lunch_break_threshold_hours: 5 }])
    .select('id').single();

  // Cantiere A: nessun override → eredita 45min/5h dall'azienda
  const { data: siteA } = await admin.from('sites').insert([{
    company_id: company.id, name: 'TEST-Cantiere-F152-A', address: 'Via Test A', status: 'attivo',
  }]).select('id').single();

  // Cantiere B: override 20min/4h
  const { data: siteB } = await admin.from('sites').insert([{
    company_id: company.id, name: 'TEST-Cantiere-F152-B', address: 'Via Test B', status: 'attivo',
    lunch_break_minutes: 20, lunch_break_threshold_hours: 4,
  }]).select('id').single();

  const { data: worker1 } = await admin.from('workers').insert([{
    company_id: company.id, full_name: 'TEST-F152-Worker1', fiscal_code: `F152A${Date.now()}`.slice(0, 16).toUpperCase(),
    badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }]).select('id').single();
  const { data: worker2 } = await admin.from('workers').insert([{
    company_id: company.id, full_name: 'TEST-F152-Worker2', fiscal_code: `F152B${Date.now()}`.slice(0, 16).toUpperCase(),
    badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }]).select('id').single();

  const rows = [
    // Worker1 @ siteA (eredita 45min/5h): turno continuo 07:37->17:01 (9h24m raw)
    { company_id: company.id, site_id: siteA.id, worker_id: worker1.id, event_type: 'ENTRY', timestamp_server: '2026-06-15T07:37:00+02:00', method: 'personal_phone' },
    { company_id: company.id, site_id: siteA.id, worker_id: worker1.id, event_type: 'EXIT',  timestamp_server: '2026-06-15T17:01:00+02:00', method: 'personal_phone' },

    // Worker1 @ siteB (override 20min/4h): turno continuo 08:00->13:00 (5h, sopra soglia 4h del cantiere)
    { company_id: company.id, site_id: siteB.id, worker_id: worker1.id, event_type: 'ENTRY', timestamp_server: '2026-06-16T08:00:00+02:00', method: 'personal_phone' },
    { company_id: company.id, site_id: siteB.id, worker_id: worker1.id, event_type: 'EXIT',  timestamp_server: '2026-06-16T13:00:00+02:00', method: 'personal_phone' },

    // Worker2 @ siteA: pausa REALE timbrata (2 coppie) — nessuna detrazione automatica aggiuntiva
    { company_id: company.id, site_id: siteA.id, worker_id: worker2.id, event_type: 'ENTRY', timestamp_server: '2026-06-15T07:00:00+02:00', method: 'personal_phone' },
    { company_id: company.id, site_id: siteA.id, worker_id: worker2.id, event_type: 'EXIT',  timestamp_server: '2026-06-15T12:00:00+02:00', method: 'personal_phone' },
    { company_id: company.id, site_id: siteA.id, worker_id: worker2.id, event_type: 'ENTRY', timestamp_server: '2026-06-15T12:45:00+02:00', method: 'personal_phone' },
    { company_id: company.id, site_id: siteA.id, worker_id: worker2.id, event_type: 'EXIT',  timestamp_server: '2026-06-15T16:00:00+02:00', method: 'personal_phone' },
  ];
  const { error: seedErr } = await admin.from('presence_logs').insert(rows);
  check('coppie ENTRY/EXIT di test seminate', !seedErr, seedErr);

  try {
    // ── Cantiere A, worker1: eredita default azienda (45min/5h) ──────────────
    const reportA = await buildWorkerHoursReport(siteA.id, company.id, '2026-06-15', '2026-06-15', worker1.id);
    const w1a = reportA.workers.find(w => w.id === worker1.id);
    check('worker1@siteA presente nel report', !!w1a, reportA);
    check('worker1@siteA: 9h24m raw - 45min = 8h39m (eredita default azienda)',
      w1a?.total_minutes === 519, w1a); // 564 - 45 = 519

    // ── Cantiere B, worker1: override 20min/4h ────────────────────────────────
    const reportB = await buildWorkerHoursReport(siteB.id, company.id, '2026-06-16', '2026-06-16', worker1.id);
    const w1b = reportB.workers.find(w => w.id === worker1.id);
    check('worker1@siteB presente nel report', !!w1b, reportB);
    check('worker1@siteB: 5h raw - 20min override = 4h40m (override cantiere, non il default azienda)',
      w1b?.total_minutes === 280, w1b); // 300 - 20 = 280

    // ── Cantiere A, worker2: pausa reale già timbrata — nessuna doppia detrazione ──
    const reportW2 = await buildWorkerHoursReport(siteA.id, company.id, '2026-06-15', '2026-06-15', worker2.id);
    const w2 = reportW2.workers.find(w => w.id === worker2.id);
    check('worker2@siteA presente nel report', !!w2, reportW2);
    // (12:00-07:00) + (16:00-12:45) = 300 + 195 = 495 min, nessuna detrazione
    check('worker2 (2 coppie, pausa reale) → nessuna detrazione automatica, somma grezza invariata',
      w2?.total_minutes === 495, w2);
    const w2Day = w2?.days?.[0];
    check('worker2: has_lunch_break_deduction = false (pausa già reale, non automatica)',
      w2Day?.has_lunch_break_deduction === false, w2Day);
  } finally {
    await admin.from('presence_logs').delete().in('worker_id', [worker1.id, worker2.id]);
    await admin.from('workers').delete().in('id', [worker1.id, worker2.id]);
    await admin.from('sites').delete().in('id', [siteA.id, siteB.id]);
    await admin.from('companies').delete().eq('id', company.id);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
