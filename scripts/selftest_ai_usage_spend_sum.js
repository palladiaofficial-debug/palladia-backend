#!/usr/bin/env node
/**
 * scripts/selftest_ai_usage_spend_sum.js
 *
 * Test di regressione per F-057 (AUDIT.md): getMonthlyAiSpend/getTodayAiSpend
 * (lib/ladiaUsageLog.js) sommavano la spesa AI lato Node dopo aver scaricato
 * le righe con .select() — ma il client Supabase/PostgREST applica un limite
 * di default di 1000 righe per query, mai reso esplicito nel codice. Trovato
 * dal vivo: la company TEST-LadiaEvals ha 1783 righe questo mese — la somma
 * calcolata risultava sistematicamente sottostimata ($8.02 invece di $14.99
 * reali), e checkAiBudget (lo stesso gate che blocca/permette Ladia in chat)
 * avrebbe permesso spesa ben oltre il tetto del piano senza mai bloccare.
 *
 * Fix: due funzioni SQL (migrazione 164) che sommano lato database — nessun
 * limite di righe trasferite, per costruzione corrette a qualunque volume.
 *
 * Questo test NON dipende dall'avere >1000 righe in questo momento (fragile
 * nel tempo): pagina TUTTE le righe reali di ladia_usage_log per la company
 * di test (bypassando esplicitamente il limite di default con .range(), a
 * differenza del codice sotto test) e confronta la somma "vera" calcolata
 * così con quella restituita da getMonthlyAiSpend/getTodayAiSpend — se un
 * giorno qualcuno reintroducesse il fetch-e-somma-in-Node senza paginazione,
 * questo test lo scoprirebbe (silenziosamente sbagliato solo sopra 1000
 * righe, esattamente come il bug originale). Nessuna scrittura sui dati.
 */
'use strict';
require('dotenv').config();
const admin = require('../lib/supabase');
const { getMonthlyAiSpend, getTodayAiSpend } = require('../lib/ladiaUsageLog');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

// Somma "vera" via paginazione esplicita — bypassa deliberatamente il limite
// di default di 1000 righe per query, a differenza del codice sotto test.
async function trueSumPaginated(companyId, sinceIso) {
  let total = 0, from = 0;
  const PAGE = 1000;
  for (;;) {
    let query = admin.from('ladia_usage_log').select('estimated_cost_usd').gte('created_at', sinceIso).range(from, from + PAGE - 1);
    if (companyId) query = query.eq('company_id', companyId);
    const { data, error } = await query;
    if (error) throw error;
    for (const r of data) total += Number(r.estimated_cost_usd);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return total;
}

async function main() {
  console.log('\n=== selftest_ai_usage_spend_sum (F-057) ===\n');

  const { data: company } = await admin.from('companies').select('id, name').eq('name', 'TEST-LadiaEvals').single();
  if (!company) { console.error('TEST-LadiaEvals non trovata'); process.exit(1); }

  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const { count } = await admin.from('ladia_usage_log').select('id', { count: 'exact', head: true })
    .eq('company_id', company.id).gte('created_at', startOfMonth.toISOString());
  console.log(`  ... ${company.name} ha ${count} righe questo mese (${count > 1000 ? 'oltre' : 'entro'} il limite di default 1000)`);

  const trueSum = await trueSumPaginated(company.id, startOfMonth.toISOString());
  const reported = await getMonthlyAiSpend(company.id);
  console.log(`  ... somma vera (paginata): ${trueSum.toFixed(6)} — getMonthlyAiSpend: ${reported.toFixed(6)}`);
  check('getMonthlyAiSpend coincide con la somma reale paginata (non tronca a 1000 righe)',
    Math.abs(trueSum - reported) < 0.000001, { trueSum, reported });

  // getTodayAiSpend — stesso principio, ambito platform-wide (non filtrato per company).
  const dayStart = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const trueTodayTotal = await trueSumPaginated(null, dayStart);
  const today = await getTodayAiSpend();
  console.log(`  ... somma vera oggi (paginata, tutte le company): ${trueTodayTotal.toFixed(6)} — getTodayAiSpend.total: ${today.total.toFixed(6)}`);
  check('getTodayAiSpend.total coincide con la somma reale paginata',
    Math.abs(trueTodayTotal - today.total) < 0.000001, { trueTodayTotal, reported: today.total });

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error('Errore imprevisto:', e.message); process.exit(1); });
