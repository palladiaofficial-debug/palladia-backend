#!/usr/bin/env node
/**
 * scripts/selftest_worker_hours_report_late_entry.js
 *
 * Regressione per la nuova regola ritardo ingresso (2026-09-10, migrations/199):
 * buildWorkerHoursReport() (usata da PDF/XLSX "Ore Lavorate") deve applicare
 * la detrazione ritardo configurata — override per cantiere se impostato,
 * altrimenti default azienda — SOLO quando shift_start_time è esplicitamente
 * configurato (mai un default silenzioso), e mai sulla seconda coppia del
 * giorno (solo sull'arrivo). Verifica anche include_overtime nell'output.
 *
 * Verifica dal vivo: seeding reale (company con shift_start_time NULL di
 * default → nessuna regola; cantiere A con shift_start_time ereditato
 * dall'azienda; cantiere B con override), chiamata reale a
 * buildWorkerHoursReport(), controllo sulle ore nette restituite.
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
  console.log('\nPalladia regression — detrazione ritardo ingresso nel report Ore Lavorate (migrations/199)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('detrazione ritardo report ore', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  // Company con shift_start_time impostato esplicitamente (regola attiva) —
  // soglia/detrazione di default (5min/30min, non toccate).
  const { data: company } = await admin.from('companies')
    .insert([{ name: 'TEST-LateEntry-Company', shift_start_time: '08:00:00' }])
    .select('id').single();

  // Cantiere A: nessun override → eredita 08:00 dall'azienda
  const { data: siteA } = await admin.from('sites').insert([{
    company_id: company.id, name: 'TEST-Cantiere-LateEntry-A', address: 'Via Test A', status: 'attivo',
  }]).select('id').single();

  // Cantiere B: override 08:30, soglia 10min, detrazione 15min
  const { data: siteB } = await admin.from('sites').insert([{
    company_id: company.id, name: 'TEST-Cantiere-LateEntry-B', address: 'Via Test B', status: 'attivo',
    shift_start_time: '08:30:00', late_entry_threshold_minutes: 10, late_entry_deduction_minutes: 15,
  }]).select('id').single();

  // Company gemella con shift_start_time NULL (default reale — regola MAI attivata) — prova che nessun default silenzioso scatta.
  const { data: companyOff } = await admin.from('companies')
    .insert([{ name: 'TEST-LateEntry-CompanyOff' }])
    .select('id').single();
  const { data: siteOff } = await admin.from('sites').insert([{
    company_id: companyOff.id, name: 'TEST-Cantiere-LateEntry-Off', address: 'Via Test Off', status: 'attivo',
  }]).select('id').single();

  const { data: worker1 } = await admin.from('workers').insert([{
    company_id: company.id, full_name: 'TEST-LateEntry-Worker1', fiscal_code: `LEW1${Date.now()}`.slice(0, 16).toUpperCase(),
    badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }]).select('id').single();
  const { data: workerOff } = await admin.from('workers').insert([{
    company_id: companyOff.id, full_name: 'TEST-LateEntry-WorkerOff', fiscal_code: `LEWO${Date.now()}`.slice(0, 16).toUpperCase(),
    badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
  }]).select('id').single();

  const rows = [
    // Worker1 @ siteA (eredita 08:00, soglia 5min, detrazione 30min): ingresso 08:14 → 9min oltre soglia → -30min
    { company_id: company.id, site_id: siteA.id, worker_id: worker1.id, event_type: 'ENTRY', timestamp_server: '2026-06-15T08:14:00+02:00', method: 'personal_phone' },
    { company_id: company.id, site_id: siteA.id, worker_id: worker1.id, event_type: 'EXIT',  timestamp_server: '2026-06-15T17:00:00+02:00', method: 'personal_phone' },

    // Worker1 @ siteB (override 08:30, soglia 10min, detrazione 15min): ingresso 08:38 → 8min oltre l'orario ma SOTTO soglia 10min → nessuna detrazione
    { company_id: company.id, site_id: siteB.id, worker_id: worker1.id, event_type: 'ENTRY', timestamp_server: '2026-06-16T08:38:00+02:00', method: 'personal_phone' },
    { company_id: company.id, site_id: siteB.id, worker_id: worker1.id, event_type: 'EXIT',  timestamp_server: '2026-06-16T13:00:00+02:00', method: 'personal_phone' },

    // WorkerOff @ siteOff (company senza shift_start_time — regola MAI attivata): ingresso molto in ritardo, nessuna detrazione possibile
    { company_id: companyOff.id, site_id: siteOff.id, worker_id: workerOff.id, event_type: 'ENTRY', timestamp_server: '2026-06-15T10:30:00+02:00', method: 'personal_phone' },
    { company_id: companyOff.id, site_id: siteOff.id, worker_id: workerOff.id, event_type: 'EXIT',  timestamp_server: '2026-06-15T17:00:00+02:00', method: 'personal_phone' },
  ];
  const { error: seedErr } = await admin.from('presence_logs').insert(rows);
  check('coppie ENTRY/EXIT di test seminate', !seedErr, seedErr);

  try {
    // ── Cantiere A, worker1: eredita default azienda (08:00, 5min, 30min) ────
    const reportA = await buildWorkerHoursReport(siteA.id, company.id, '2026-06-15', '2026-06-15', worker1.id);
    const w1a = reportA.workers.find(w => w.id === worker1.id);
    check('worker1@siteA presente nel report', !!w1a, reportA);
    // 08:14->17:00 = 526min raw; turno singolo continuo >6h → -60 pausa pranzo
    // automatica (default, migration 195, sempre attiva indipendentemente dal
    // ritardo) = 466; poi -30 ritardo (9min oltre soglia 5min) = 436.
    check('worker1@siteA: ingresso 08:14 (9min oltre soglia 5min) → detratti 30min ritardo sopra i 60min pausa pranzo (436min totali)',
      w1a?.total_minutes === 436 && w1a?.late_deduction_minutes === 30 && w1a?.late_days === 1, w1a);

    // ── Cantiere B, worker1: override 08:30/10min/15min ───────────────────────
    const reportB = await buildWorkerHoursReport(siteB.id, company.id, '2026-06-16', '2026-06-16', worker1.id);
    const w1b = reportB.workers.find(w => w.id === worker1.id);
    check('worker1@siteB presente nel report', !!w1b, reportB);
    // 08:38->13:00 = 262min raw, sotto soglia 10min → nessuna detrazione
    check('worker1@siteB: ingresso 08:38 (8min oltre l\'orario, sotto soglia 10min override) → nessuna detrazione (262min totali)',
      w1b?.total_minutes === 262 && w1b?.late_deduction_minutes === 0, w1b);

    // ── Cantiere senza shift_start_time configurato: regola mai attivata ──────
    const reportOff = await buildWorkerHoursReport(siteOff.id, companyOff.id, '2026-06-15', '2026-06-15', workerOff.id);
    const wOff = reportOff.workers.find(w => w.id === workerOff.id);
    check('workerOff presente nel report', !!wOff, reportOff);
    // 10:30->17:00 = 390min raw; >6h → -60 pausa pranzo (sempre attiva, non
    // dipende dal ritardo) = 330; ZERO detrazione ritardo (shift_start_time
    // mai configurato per questa company).
    check('company senza shift_start_time configurato → ingresso molto in ritardo, ZERO detrazione ritardo (default silenzioso mai applicato)',
      wOff?.total_minutes === 330 && wOff?.late_deduction_minutes === 0, wOff);

    // ── include_overtime nell'output ───────────────────────────────────────────
    const reportDefault = await buildWorkerHoursReport(siteA.id, company.id, '2026-06-15', '2026-06-15', worker1.id);
    check('buildWorkerHoursReport senza includeOvertime esplicito → include_overtime true (compatibilità)',
      reportDefault.include_overtime === true, reportDefault.include_overtime);
    const reportNoOt = await buildWorkerHoursReport(siteA.id, company.id, '2026-06-15', '2026-06-15', worker1.id, false);
    check('buildWorkerHoursReport(includeOvertime=false) → include_overtime false nell\'output',
      reportNoOt.include_overtime === false, reportNoOt.include_overtime);
    check('include_overtime=false NON tocca il calcolo delle ore (stesso total_minutes)',
      reportNoOt.workers.find(w => w.id === worker1.id)?.total_minutes === 436, reportNoOt);
  } finally {
    await admin.from('presence_logs').delete().in('worker_id', [worker1.id, workerOff.id]);
    await admin.from('workers').delete().in('id', [worker1.id, workerOff.id]);
    await admin.from('sites').delete().in('id', [siteA.id, siteB.id, siteOff.id]);
    await admin.from('companies').delete().in('id', [company.id, companyOff.id]);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
