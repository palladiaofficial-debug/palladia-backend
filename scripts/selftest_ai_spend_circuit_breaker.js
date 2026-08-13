#!/usr/bin/env node
/**
 * scripts/selftest_ai_spend_circuit_breaker.js
 *
 * Regressione per il circuit breaker sulla spesa AI giornaliera dell'intera
 * piattaforma (lib/ladiaUsageLog.js::checkGlobalDailySpendCircuitBreaker,
 * migrazione 159 ai_spend_alerts). Due proprietà verificate dal vivo, con DB
 * reale, non lette nel codice:
 *
 * 1) getTodayAiSpend() incorpora davvero righe fresche di ladia_usage_log
 *    (verifica per DELTA, non per totale assoluto — la funzione somma
 *    l'intera piattaforma, non una company: il totale assoluto dipende da
 *    quanto altro è già successo oggi, il delta prodotto da questo test no).
 * 2) Il dedup durevole su ai_spend_alerts(alert_date) impedisce un secondo
 *    allarme lo stesso giorno solare — proprietà critica: senza questo, un
 *    riavvio del processo o più istanze Railway manderebbero email duplicate
 *    ogni volta che ripassano la soglia.
 *
 * Deliberatamente NON testato qui (vedi AUDIT.md): il percorso "prima volta,
 * invio email reale" — invocherebbe davvero Resend verso ADMIN_EMAIL ad ogni
 * run di `npm test`, cosa che allarmerebbe il fondatore con un'email reale
 * ma non vera. Verificato una volta dal vivo con soglia abbassata a mano su
 * un server reale (vedi nota in AUDIT.md), non in automatico e ripetuto.
 *
 * IMPORTANTE: imposta AI_SPEND_DAILY_LIMIT_USD PRIMA di richiedere
 * lib/ladiaUsageLog.js — la costante è letta una sola volta al load del
 * modulo (stessa convenzione di MASTER_COMPANY_IDS nello stesso file).
 */
'use strict';
require('dotenv').config();
process.env.AI_SPEND_DAILY_LIMIT_USD = '0.000001'; // qualunque spesa > 0 la supera

const { createClient } = require('@supabase/supabase-js');
const { getTodayAiSpend, checkGlobalDailySpendCircuitBreaker } = require('../lib/ladiaUsageLog');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function todayRomeKey() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
}

async function main() {
  console.log('\nPalladia regression — circuit breaker spesa AI giornaliera (migrazione 159)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('circuit breaker spesa AI', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const alertDate = todayRomeKey();

  let tempCompanyId = null;
  let seededLogIds = [];
  let seededAlertId = null;

  try {
    // ── Setup: azienda temporanea, per non sporcare la spesa reale dei clienti ──
    const { data: company, error: companyErr } = await admin
      .from('companies')
      .insert({ name: `TEST-CircuitBreaker-${Date.now()}`, subscription_plan: 'starter' })
      .select('id')
      .single();
    check('Creata azienda temporanea', !companyErr && !!company?.id, companyErr);
    tempCompanyId = company?.id;

    // ── 1) getTodayAiSpend() incorpora righe fresche (verifica per delta) ──
    const before = await getTodayAiSpend();

    const seedRows = [
      { company_id: tempCompanyId, model: 'claude-haiku-4-5', call_site: 'selftest', is_internal: false, estimated_cost_usd: 1.23 },
      { company_id: tempCompanyId, model: 'claude-haiku-4-5', call_site: 'selftest', is_internal: true,  estimated_cost_usd: 4.56 },
    ];
    const { data: inserted, error: seedErr } = await admin.from('ladia_usage_log').insert(seedRows).select('id');
    check('Righe di test seminate in ladia_usage_log', !seedErr && inserted?.length === 2, seedErr);
    seededLogIds = (inserted || []).map(r => r.id);

    const after = await getTodayAiSpend();
    const deltaTotal    = after.total - before.total;
    const deltaExternal = after.external - before.external;
    check('getTodayAiSpend(): il totale cresce esattamente di 1.23+4.56=5.79', Math.abs(deltaTotal - 5.79) < 0.001, { before, after, deltaTotal });
    check('getTodayAiSpend(): "clienti reali" cresce solo di 1.23 (is_internal escluso)', Math.abs(deltaExternal - 1.23) < 0.001, { before, after, deltaExternal });

    // ── 2) Dedup durevole: un'allerta già presente oggi blocca un secondo INSERT ──
    const { data: alertRow, error: alertSeedErr } = await admin.from('ai_spend_alerts').insert({
      alert_date: alertDate, total_spend_usd: 999, external_spend_usd: 999, threshold_usd: 0.000001,
    }).select('id').single();
    check('Riga ai_spend_alerts pre-esistente per oggi seminata', !alertSeedErr && !!alertRow?.id, alertSeedErr);
    seededAlertId = alertRow?.id;

    const { count: countBefore } = await admin.from('ai_spend_alerts').select('id', { count: 'exact', head: true }).eq('alert_date', alertDate);

    // Chiamata reale alla funzione di produzione: soglia praticamente a zero,
    // quindi la spesa di oggi (anche solo quella appena seminata) la supera
    // di sicuro — l'unica cosa che deve impedire un secondo invio è il dedup
    // su ai_spend_alerts, non il confronto con la soglia.
    let threw = null;
    try { await checkGlobalDailySpendCircuitBreaker(); } catch (e) { threw = e; }
    check('checkGlobalDailySpendCircuitBreaker() non lancia mai (fail-open)', threw === null, threw?.message);

    const { count: countAfter } = await admin.from('ai_spend_alerts').select('id', { count: 'exact', head: true }).eq('alert_date', alertDate);
    check('Nessuna riga duplicata per oggi — il dedup ha bloccato il secondo INSERT', countAfter === countBefore, { countBefore, countAfter });
  } finally {
    // Pulizia — la riga ai_spend_alerts va rimossa SEMPRE: se restasse per la
    // data di oggi, sopprimerebbe una vera allerta di produzione per il resto
    // della giornata.
    if (seededAlertId) await admin.from('ai_spend_alerts').delete().eq('id', seededAlertId);
    if (seededLogIds.length) await admin.from('ladia_usage_log').delete().in('id', seededLogIds);
    if (tempCompanyId) await admin.from('companies').delete().eq('id', tempCompanyId);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
