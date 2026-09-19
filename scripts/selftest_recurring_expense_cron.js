#!/usr/bin/env node
'use strict';
/**
 * scripts/selftest_recurring_expense_cron.js
 *
 * F-216 (AUDIT.md), seguito: le "spese fisse mensili" erano solo un template
 * per la previsione di cassa, mai una spesa reale — nessun modo di segnarle
 * pagate, nessuna riconciliazione. services/recurringExpenseCron.js le
 * materializza in una vera riga company_expenses il giorno in cui scadono.
 *
 * Verifica:
 * 1) Un template con day_of_month = oggi genera una riga company_expenses
 *    con recurring_expense_id collegato, source='recurring'.
 * 2) Rieseguendo lo stesso giorno NON crea un duplicato (idempotenza).
 * 3) Un template con day_of_month diverso da oggi non genera nulla.
 * 4) Un template disattivato (is_active=false) non genera nulla.
 * 5) Una volta segnata pagata la riga materializzata, previsione_30gg la
 *    esclude da in_uscita_certa (non deve continuare a proiettarsi come
 *    "sta per uscire" se è già uscita davvero).
 */
require('dotenv').config();
const supabase = require('../lib/supabase');
const { runRecurringExpenseMaterialization } = require('../services/recurringExpenseCron');
const { buildCompanyEconomiaOverview } = require('../services/economiaOverview');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia — Materializzazione spese fisse mensili (F-216)\n');

  let companyId, recDueId, recNotDueId, recInactiveId;
  const expenseIds = [];
  const todayDay = new Date().getDate();
  const otherDay = todayDay === 1 ? 2 : 1; // sicuramente diverso da oggi

  try {
    const { data: company } = await supabase.from('companies').insert({ name: 'TEST-RecurringExpenseCron' }).select().single();
    companyId = company.id;

    const { data: recDue } = await supabase.from('company_recurring_expenses').insert({
      company_id: companyId, amount: 850, description: 'TEST Affitto', day_of_month: todayDay,
    }).select().single();
    recDueId = recDue.id;

    const { data: recNotDue } = await supabase.from('company_recurring_expenses').insert({
      company_id: companyId, amount: 200, description: 'TEST Non in scadenza oggi', day_of_month: otherDay,
    }).select().single();
    recNotDueId = recNotDue.id;

    const { data: recInactive } = await supabase.from('company_recurring_expenses').insert({
      company_id: companyId, amount: 999, description: 'TEST Disattivata', day_of_month: todayDay, is_active: false,
    }).select().single();
    recInactiveId = recInactive.id;

    // ── Primo giro ──────────────────────────────────────────────────────
    await runRecurringExpenseMaterialization();

    const { data: afterFirst } = await supabase.from('company_expenses')
      .select('*').eq('company_id', companyId);
    (afterFirst || []).forEach(e => expenseIds.push(e.id));

    const dueRow = (afterFirst || []).find(e => e.recurring_expense_id === recDueId);
    check('Template in scadenza oggi → riga company_expenses creata', !!dueRow, afterFirst);
    check('Riga materializzata: importo corretto (850€)', dueRow?.amount === 850, dueRow);
    check('Riga materializzata: source = recurring', dueRow?.source === 'recurring', dueRow);
    check('Template NON in scadenza oggi → nessuna riga', !(afterFirst || []).some(e => e.recurring_expense_id === recNotDueId), afterFirst);
    check('Template disattivato → nessuna riga anche se il giorno combacia', !(afterFirst || []).some(e => e.recurring_expense_id === recInactiveId), afterFirst);

    // ── Secondo giro, stesso giorno — idempotenza ───────────────────────
    await runRecurringExpenseMaterialization();
    const { data: afterSecond } = await supabase.from('company_expenses')
      .select('id').eq('company_id', companyId).eq('recurring_expense_id', recDueId);
    check('Rieseguito lo stesso giorno: nessun duplicato (1 sola riga)', (afterSecond || []).length === 1, afterSecond);

    // ── Riconciliazione con la previsione 30gg ──────────────────────────
    // 1.050€ = 850 (template in scadenza oggi) + 200 (l'altro template, non
    // ancora materializzato ma la cui prossima occorrenza cade comunque
    // entro 30gg — qualunque ricorrenza mensile lo è per costruzione).
    const overviewBefore = await buildCompanyEconomiaOverview(companyId);
    check('Prima di segnarla pagata: previsione conta entrambi i template (1.050€)', overviewBefore.previsione_30gg.in_uscita_certa === 1050, overviewBefore.previsione_30gg);

    await supabase.from('company_expenses').update({ pagato_il: new Date().toISOString().slice(0, 10) }).eq('id', dueRow.id);
    const overviewAfter = await buildCompanyEconomiaOverview(companyId);
    check('Dopo averla segnata pagata: previsione esclude i suoi 850€, resta solo l\'altro template (200€)', overviewAfter.previsione_30gg.in_uscita_certa === 200, overviewAfter.previsione_30gg);

  } finally {
    if (expenseIds.length) await supabase.from('company_expenses').delete().in('id', expenseIds);
    if (recDueId) await supabase.from('company_recurring_expenses').delete().eq('id', recDueId);
    if (recNotDueId) await supabase.from('company_recurring_expenses').delete().eq('id', recNotDueId);
    if (recInactiveId) await supabase.from('company_recurring_expenses').delete().eq('id', recInactiveId);
    if (companyId) await supabase.from('companies').delete().eq('id', companyId);
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
