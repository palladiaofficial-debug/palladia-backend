'use strict';
/**
 * services/monthlyReportCron.js
 *
 * Il 1° di ogni mese alle 08:00 (Europe/Rome): invia a ogni impresa il report
 * "Il tuo mese con Palladia" (ultimo mese solare completato). Salta le company
 * senza nessuna attività rilevante nel mese (stesso principio di weeklyValueCron:
 * niente email vuote) — la decisione di cosa contare come "attività" è dentro
 * services/monthlyValueReport.js, non duplicata qui.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { sendMonthlyReportForCompany } = require('./monthlyValueReport');

async function runMonthlyReport() {
  console.log('[monthlyReport] avvio report mensile impresa');

  const { data: companies, error } = await supabase.from('companies').select('id');
  if (error) {
    console.error('[monthlyReport] errore fetch companies:', error.message);
    return;
  }

  let sent = 0, skipped = 0, failed = 0;
  for (const { id } of companies || []) {
    try {
      const result = await sendMonthlyReportForCompany(id);
      if (result.sent) sent++; else skipped++;
    } catch (e) {
      failed++;
      console.error(`[monthlyReport] errore company ${id}:`, e.message);
    }
  }

  console.log(`[monthlyReport] completato — ${sent} inviati, ${skipped} saltati (nessuna attività/destinatario), ${failed} errori`);
}

function startMonthlyReportCron() {
  // Il 1° di ogni mese alle 08:00 Europe/Rome
  cron.schedule('0 8 1 * *', () => {
    runMonthlyReport().catch(e => console.error('[monthlyReport] errore fatale:', e.message));
  }, { timezone: 'Europe/Rome' });

  console.log('[cron] monthly-value-report attivo — 1° del mese, 08:00 Europe/Rome');
}

module.exports = { startMonthlyReportCron, runMonthlyReport };
