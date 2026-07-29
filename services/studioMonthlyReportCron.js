'use strict';
/**
 * services/studioMonthlyReportCron.js
 *
 * Il 1° di ogni mese alle 08:30 (Europe/Rome) — 30 minuti dopo il report
 * mensile impresa (services/monthlyReportCron.js, 08:00), così i dati per
 * ogni cliente sono già stabili quando lo studio li aggrega. Un'unica email
 * per studio all'owner, con il dettaglio per cliente — vedi
 * services/studioMonthlyReport.js.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { sendStudioMonthlyReportForStudio } = require('./studioMonthlyReport');

async function runStudioMonthlyReport() {
  console.log('[studioMonthlyReport] avvio report mensile studio');

  const { data: studios, error } = await supabase
    .from('studio_partners')
    .select('id')
    .eq('onboarding_completed', true);

  if (error) {
    console.error('[studioMonthlyReport] errore fetch studios:', error.message);
    return;
  }

  let sent = 0, skipped = 0, failed = 0;
  for (const { id } of studios || []) {
    try {
      const result = await sendStudioMonthlyReportForStudio(id);
      if (result.sent) sent++; else skipped++;
    } catch (e) {
      failed++;
      console.error(`[studioMonthlyReport] errore studio ${id}:`, e.message);
    }
  }

  console.log(`[studioMonthlyReport] completato — ${sent} inviati, ${skipped} saltati, ${failed} errori`);
}

function startStudioMonthlyReportCron() {
  cron.schedule('30 8 1 * *', () => {
    runStudioMonthlyReport().catch(e => console.error('[studioMonthlyReport] errore fatale:', e.message));
  }, { timezone: 'Europe/Rome' });

  console.log('[cron] studio-monthly-value-report attivo — 1° del mese, 08:30 Europe/Rome');
}

module.exports = { startStudioMonthlyReportCron, runStudioMonthlyReport };
