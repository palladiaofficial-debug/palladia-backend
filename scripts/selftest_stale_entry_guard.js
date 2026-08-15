#!/usr/bin/env node
/**
 * scripts/selftest_stale_entry_guard.js
 *
 * Test di regressione per F-043 (AUDIT.md) — turno fantasma:
 * un'ENTRY rimasta aperta per giorni veniva abbinata come EXIT dal
 * tocco successivo del lavoratore, creando un turno di durata assurda,
 * invece di essere trattata come un nuovo turno.
 *
 * Copre due fix distinti, entrambi chiamati DAL VIVO contro il DB reale
 * (RPC punch_atomic, la stessa che chiama routes/v1/badgePunch.js):
 *
 *  1. punch_atomic (migrazione 161) — un'ENTRY più vecchia di 16h non
 *     viene più chiusa dal tocco corrente: viene auto-chiusa a un orario
 *     plausibile e il tocco corrente apre un turno NUOVO.
 *  2. missingExitCron.checkCompany + ladiaActions.registerMissingExits
 *     (services/missingExitCron.js, services/ladiaActions.js) — un'ENTRY
 *     vecchia di qualche giorno viene trovata (non solo quelle di oggi) e,
 *     se chiusa dal cron, l'EXIT viene registrato sullo STESSO giorno
 *     dell'entrata, non sul giorno in cui gira il cron.
 *
 * Crea ed elimina dati di test reali (company/site/worker dedicati).
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { registerMissingExits } = require('../services/ladiaActions');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }

async function setup() {
  const { data: company, error: cErr } = await supabase.from('companies').insert({
    name: 'TEST-F043-StaleEntry',
  }).select('id').single();
  if (cErr) throw new Error('crea company: ' + cErr.message);

  // 3 cantieri distinti — un cantiere per test, per non incappare nel rate
  // limit di 60s tra punch consecutivi dello stesso worker sullo stesso
  // cantiere (punch_atomic, "PUNCH_TOO_SOON").
  const siteNames = ['TEST-F043-Cantiere-1', 'TEST-F043-Cantiere-2', 'TEST-F043-Cantiere-3'];
  const siteIds = [];
  for (const name of siteNames) {
    const { data: site, error: sErr } = await supabase.from('sites').insert({
      company_id: company.id, name, status: 'attivo', address: 'Via Test 1',
    }).select('id').single();
    if (sErr) throw new Error('crea site: ' + sErr.message);
    siteIds.push(site.id);
  }

  const { data: worker, error: wErr } = await supabase.from('workers').insert({
    company_id: company.id, full_name: 'TEST-F043 Worker', is_active: true,
    fiscal_code: `TSTF43${Date.now()}`.slice(0, 16).toUpperCase(),
    badge_code: `TSTF43${Date.now()}`,
  }).select('id').single();
  if (wErr) throw new Error('crea worker: ' + wErr.message);

  return { companyId: company.id, siteId: siteIds[0], site2Id: siteIds[1], site3Id: siteIds[2], siteIds, workerId: worker.id };
}

async function cleanup({ companyId, siteIds, workerId }) {
  if (workerId) await supabase.from('presence_logs').delete().eq('worker_id', workerId);
  if (workerId) await supabase.from('workers').delete().eq('id', workerId);
  for (const siteId of (siteIds || [])) {
    await supabase.from('sites').delete().eq('id', siteId);
  }
  if (companyId) await supabase.from('companies').delete().eq('id', companyId);
}

async function punch(ctx, method = 'worker_self_punch') {
  return supabase.rpc('punch_atomic', {
    p_site_id:    ctx.siteId,
    p_worker_id:  ctx.workerId,
    p_company_id: ctx.companyId,
    p_session_id: null,
    p_lat:        null,
    p_lon:        null,
    p_distance_m: null,
    p_accuracy_m: null,
    p_ip:         'selftest',
    p_ua:         'selftest',
    p_method:     method,
  });
}

async function main() {
  console.log('\n\x1b[1mF-043 — guardia anti-turno-fantasma (punch_atomic + cron uscite mancanti)\x1b[0m');

  const ctx = await setup();

  try {
    // ── TEST 1: ENTRY vecchia di 20h → il tocco corrente NON deve
    //    abbinarsi come EXIT, deve aprire un turno nuovo e chiudere quello
    //    vecchio automaticamente a un orario plausibile. ──────────────────
    const staleEntryTs = new Date(Date.now() - 20 * 3600_000).toISOString();
    await supabase.from('presence_logs').insert({
      company_id: ctx.companyId, site_id: ctx.siteId, worker_id: ctx.workerId,
      event_type: 'ENTRY', timestamp_server: staleEntryTs, method: 'worker_self_punch',
    });

    const { data: r1, error: e1 } = await punch(ctx);
    if (e1) fail('punch dopo ENTRY vecchia di 20h non va in errore RPC', e1.message);
    else if (r1?.ok && r1.event_type === 'ENTRY' && r1.auto_closed_stale === true) {
      ok('ENTRY vecchia di 20h NON abbinata come EXIT — nuovo turno aperto, quello vecchio auto-chiuso');
    } else {
      fail('ENTRY vecchia di 20h NON abbinata come EXIT — nuovo turno aperto, quello vecchio auto-chiuso', r1);
    }

    const { data: logsAfter1 } = await supabase
      .from('presence_logs').select('event_type, timestamp_server, method')
      .eq('worker_id', ctx.workerId).order('timestamp_server', { ascending: true });

    const staleExit = (logsAfter1 || []).find(l => l.method === 'auto_exit_stale_before_reopen');
    if (staleExit && staleExit.event_type === 'EXIT') {
      ok('l\'ENTRY vecchia è stata chiusa con method=auto_exit_stale_before_reopen');
    } else {
      fail('l\'ENTRY vecchia è stata chiusa con method=auto_exit_stale_before_reopen', logsAfter1);
    }

    const durationHoursIfWronglyPaired = staleExit
      ? (new Date(staleExit.timestamp_server) - new Date(staleEntryTs)) / 3600_000
      : null;
    if (durationHoursIfWronglyPaired !== null && durationHoursIfWronglyPaired < 24) {
      ok(`l'uscita automatica dell'entrata vecchia è a un orario plausibile (${durationHoursIfWronglyPaired.toFixed(1)}h dopo, non giorni)`);
    } else {
      fail('l\'uscita automatica dell\'entrata vecchia è a un orario plausibile', durationHoursIfWronglyPaired);
    }

    // ── TEST 2: ENTRY vecchia di 2h (stesso turno) → deve chiudersi
    //    normalmente come EXIT, comportamento pre-esistente invariato.
    //    Cantiere diverso da TEST 1 per non incappare nel rate limit 60s. ──
    const freshEntryTs = new Date(Date.now() - 2 * 3600_000).toISOString();
    await supabase.from('presence_logs').insert({
      company_id: ctx.companyId, site_id: ctx.site2Id, worker_id: ctx.workerId,
      event_type: 'ENTRY', timestamp_server: freshEntryTs, method: 'worker_self_punch',
    });
    const { data: r2, error: e2 } = await punch({ ...ctx, siteId: ctx.site2Id });
    if (e2) fail('punch dopo ENTRY di 2h fa non va in errore RPC', e2.message);
    else if (r2?.ok && r2.event_type === 'EXIT' && r2.auto_closed_stale === false) {
      ok('ENTRY di 2h fa (stesso turno) si chiude normalmente come EXIT — comportamento invariato');
    } else {
      fail('ENTRY di 2h fa (stesso turno) si chiude normalmente come EXIT — comportamento invariato', r2);
    }

    // ── TEST 3: cron — un'ENTRY di 3 giorni fa viene trovata dal backfill
    //    (non solo le entrate di oggi) e, se chiusa, l'EXIT è registrato
    //    sullo STESSO giorno dell'entrata, non sul giorno di oggi. ────────
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600_000);
    const entryDate = threeDaysAgo.toISOString().slice(0, 10);
    await supabase.from('presence_logs').insert({
      company_id: ctx.companyId, site_id: ctx.site3Id, worker_id: ctx.workerId,
      event_type: 'ENTRY', timestamp_server: `${entryDate}T08:00:00.000Z`, method: 'worker_self_punch',
    });

    const today = new Date().toISOString().slice(0, 10);
    const result = await registerMissingExits(ctx.site3Id, today, ctx.companyId, null);

    if (result.ok && result.count === 1) {
      ok('registerMissingExits trova e chiude un\'ENTRY di 3 giorni fa (backfill, non solo oggi)');
    } else {
      fail('registerMissingExits trova e chiude un\'ENTRY di 3 giorni fa (backfill, non solo oggi)', result);
    }

    const { data: logsAfter3 } = await supabase
      .from('presence_logs').select('event_type, timestamp_server')
      .eq('worker_id', ctx.workerId).eq('site_id', ctx.site3Id).eq('event_type', 'EXIT')
      .order('timestamp_server', { ascending: false }).limit(1);
    const exitDate = logsAfter3?.[0]?.timestamp_server?.slice(0, 10);
    if (exitDate === entryDate) {
      ok(`l'EXIT auto-generato è sullo stesso giorno dell'entrata (${entryDate}), non sul giorno del cron (${today})`);
    } else {
      fail(`l'EXIT auto-generato è sullo stesso giorno dell'entrata (${entryDate})`, exitDate);
    }

  } finally {
    await cleanup(ctx);
  }

  report();
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_stale_entry_guard:', e.message);
  process.exit(1);
});
