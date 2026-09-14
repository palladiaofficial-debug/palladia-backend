#!/usr/bin/env node
/**
 * scripts/selftest_report_excludes_test_and_inactive_workers.js
 *
 * Regressione per F-184 (AUDIT.md, 2026-09-14, seguito): il titolare ha
 * segnalato che il PDF "Registro Presenze Cantiere" di un cliente reale
 * (MSCedilizia S.r.l., cantiere Corso Sardegna 88) conteneva due righe
 * "TEST-PilotaGeofence" — una fixture di verifica live seminata per errore
 * sulla company reale invece che su una dedicata, mai esclusa da nessun
 * filtro nel report ufficiale.
 *
 * Fix: lib/presencePairing.js::isTestOrInactiveWorker(worker, companyName)
 * esclude un lavoratore disattivato SEMPRE, e un lavoratore con nome
 * "TEST-..." SOLO quando la company del report non è essa stessa una
 * company "TEST-..." — i selftest di questo repo (100+) creano
 * deliberatamente lavoratori "TEST-..." dentro company "TEST-..." dedicate
 * per verificare che il report LI INCLUDA: un'esclusione incondizionata per
 * prefisso avrebbe rotto quel pattern (verificato: prima di scoping per
 * company, selftest_presence_report_lunch_break.js passava da verde a
 * rosso — "riga del lavoratore presente: got []").
 *
 * Verifica dal vivo entrambi i report che condividono il filtro
 * (buildDailyPresenceSummary + buildWorkerHoursReport).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, il test si salta.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { buildDailyPresenceSummary } = require('../services/presenceReport');
const { buildWorkerHoursReport }    = require('../services/workerHoursReport');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — i report escludono lavoratori TEST-/disattivati in company reali, non in company di test (F-184)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('report excludes test/inactive workers', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  async function makeCompanyWithSiteAndWorkers(companyName) {
    const { data: company } = await admin.from('companies').insert([{ name: companyName }]).select('id').single();
    const { data: site } = await admin.from('sites').insert([{
      company_id: company.id, name: `Cantiere ${companyName}`, address: 'Via Test', status: 'attivo',
    }]).select('id').single();

    async function makeWorker(fullName, isActive) {
      const uniq = `${Date.now()}${Math.floor(Math.random() * 9999)}`;
      const { data: w } = await admin.from('workers').insert([{
        company_id: company.id, full_name: fullName, fiscal_code: `F184X${uniq}`.slice(0, 16).toUpperCase(),
        is_active: isActive, badge_code: crypto.randomBytes(9).toString('hex').toUpperCase(),
      }]).select('id').single();
      return w.id;
    }

    return { company, site, makeWorker };
  }

  async function seedShift(companyId, siteId, workerId, dateIso) {
    await admin.from('presence_logs').insert([
      { company_id: companyId, site_id: siteId, worker_id: workerId, event_type: 'ENTRY', timestamp_server: `${dateIso}T07:00:00+02:00`, method: 'worker_self_punch' },
      { company_id: companyId, site_id: siteId, worker_id: workerId, event_type: 'EXIT',  timestamp_server: `${dateIso}T15:00:00+02:00`, method: 'worker_self_punch' },
    ]);
  }

  const DATE = '2026-06-10';

  // ── Scenario 1: company REALE (nome non-TEST) con 3 lavoratori: reale attivo,
  //    TEST- attivo (fixture seminata per errore), reale disattivato ──────────
  {
    const { company, site, makeWorker } = await makeCompanyWithSiteAndWorkers('MSCedilizia-F184-RealCo');
    const realWorker   = await makeWorker('Mario Rossi', true);
    const testWorker   = await makeWorker('TEST-PilotaGeofence', true);   // caso reale segnalato
    const inactiveReal = await makeWorker('Ex Dipendente', false);
    await seedShift(company.id, site.id, realWorker, DATE);
    await seedShift(company.id, site.id, testWorker, DATE);
    await seedShift(company.id, site.id, inactiveReal, DATE);

    const presence = await buildDailyPresenceSummary(site.id, company.id, DATE, DATE);
    const presenceNames = presence.rows.map(r => r.worker_name);
    check('Registro Presenze (company reale): include il lavoratore reale', presenceNames.includes('Mario Rossi'), presenceNames);
    check('Registro Presenze (company reale): ESCLUDE la fixture TEST-', !presenceNames.includes('TEST-PilotaGeofence'), presenceNames);
    check('Registro Presenze (company reale): ESCLUDE il lavoratore disattivato', !presenceNames.includes('Ex Dipendente'), presenceNames);

    const hours = await buildWorkerHoursReport(site.id, company.id, DATE, DATE);
    const hoursNames = hours.workers.map(w => w.full_name);
    check('Report Ore Lavorate (company reale): include il lavoratore reale', hoursNames.includes('Mario Rossi'), hoursNames);
    check('Report Ore Lavorate (company reale): ESCLUDE la fixture TEST-', !hoursNames.includes('TEST-PilotaGeofence'), hoursNames);
    check('Report Ore Lavorate (company reale): ESCLUDE il lavoratore disattivato', !hoursNames.includes('Ex Dipendente'), hoursNames);
  }

  // ── Scenario 2: company DI TEST (nome "TEST-...") — i lavoratori TEST- devono
  //    restare inclusi, altrimenti 100+ selftest di questo repo si romperebbero ──
  {
    const { company, site, makeWorker } = await makeCompanyWithSiteAndWorkers('TEST-F184-TestCo');
    const testWorker = await makeWorker('TEST-F184-Worker', true);
    await seedShift(company.id, site.id, testWorker, DATE);

    const presence = await buildDailyPresenceSummary(site.id, company.id, DATE, DATE);
    check('Registro Presenze (company DI TEST): un lavoratore TEST- resta incluso',
      presence.rows.map(r => r.worker_name).includes('TEST-F184-Worker'), presence.rows.map(r => r.worker_name));

    const hours = await buildWorkerHoursReport(site.id, company.id, DATE, DATE);
    check('Report Ore Lavorate (company DI TEST): un lavoratore TEST- resta incluso',
      hours.workers.map(w => w.full_name).includes('TEST-F184-Worker'), hours.workers.map(w => w.full_name));
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e.stack); process.exitCode = 1; });
