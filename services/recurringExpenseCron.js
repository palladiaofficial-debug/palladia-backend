'use strict';
/**
 * services/recurringExpenseCron.js
 *
 * F-216 (AUDIT.md), seguito: le "spese fisse mensili" (company_recurring_expenses)
 * erano solo un template usato per la previsione di cassa — non diventavano mai
 * una spesa reale tracciabile, non finivano mai in "Da pagare", non si potevano
 * segnare come pagate. Questo cron le materializza in una vera riga
 * company_expenses il giorno in cui scadono (day_of_month, clampato a fine mese
 * come già fa POST /expenses/recurring), collegata al template via
 * recurring_expense_id (migrazione 225) — da lì in poi è una spesa come
 * qualunque altra: appare in Spese generali, si può modificare/eliminare/segnare
 * pagata con gli endpoint già esistenti, nessuna UI nuova.
 *
 * Idempotente: prima di inserire controlla se esiste già una riga per lo stesso
 * recurring_expense_id nel mese corrente — un riavvio del server o un doppio
 * trigger nello stesso giorno non crea un duplicato.
 *
 * Avvio: chiamare startRecurringExpenseCron() da server.js al boot.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');

function todayInfo() {
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  return { day: now.getDate(), lastDay, monthStart, iso: now.toISOString().slice(0, 10) };
}

async function runRecurringExpenseMaterialization() {
  const { day, lastDay, monthStart, iso } = todayInfo();

  const { data: recurring, error } = await supabase
    .from('company_recurring_expenses')
    .select('*')
    .eq('is_active', true);
  if (error) { console.error('[recurringExpense] fetch error:', error.message); return; }

  const due = (recurring || []).filter(r => Math.min(r.day_of_month, lastDay) === day);
  if (!due.length) { console.log('[recurringExpense] nessuna spesa fissa in scadenza oggi.'); return; }

  let created = 0;
  for (const r of due) {
    const { data: existing, error: checkErr } = await supabase
      .from('company_expenses')
      .select('id')
      .eq('recurring_expense_id', r.id)
      .gte('expense_date', monthStart)
      .limit(1);
    if (checkErr) { console.error(`[recurringExpense] check fallito per ${r.id}:`, checkErr.message); continue; }
    if (existing?.length) continue; // già materializzata questo mese

    const { error: insErr } = await supabase.from('company_expenses').insert({
      company_id:            r.company_id,
      amount:                r.amount,
      description:           r.description,
      category:              r.category,
      payment_method:        r.payment_method,
      paid_by:               r.paid_by,
      supplier:              r.supplier,
      expense_date:          iso,
      is_deductible:         true,
      notes:                 'Generata da spesa fissa mensile',
      source:                'recurring',
      recurring_expense_id:  r.id,
    });
    if (insErr) { console.error(`[recurringExpense] insert fallito per ${r.id}:`, insErr.message); continue; }
    created++;
  }
  console.log(`[recurringExpense] materializzate ${created}/${due.length} spese fisse in scadenza oggi.`);
}

function startRecurringExpenseCron() {
  cron.schedule('20 6 * * *', async () => {
    try { await runRecurringExpenseMaterialization(); }
    catch (e) { console.error('[recurringExpense] errore cron:', e.message); }
  }, { timezone: 'Europe/Rome' });
  console.log('[cron] recurring-expense attivo — 06:20 Europe/Rome');
}

module.exports = { startRecurringExpenseCron, runRecurringExpenseMaterialization };
