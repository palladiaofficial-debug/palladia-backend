'use strict';
/**
 * services/studioDurcAlertCron.js
 * Cron giornaliero (07:45) — alert DURC in scadenza per lo studio CDL.
 * Per ogni studio che ha clienti con DURC in scadenza entro 30 giorni,
 * invia una email riepilogativa con l'elenco dei clienti da contattare.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { inDays, daysUntil } = require('./expiryHelper');
const { sendStudioDurcAlert } = require('./email');

async function runStudioDurcAlertCheck() {
  console.log('[studioDurcAlert] avvio controllo DURC clienti studio...');

  const t30 = inDays(30);

  const { data: clients, error } = await supabase
    .from('studio_clients')
    .select(`
      studio_id,
      company_id,
      studio_partners(id, studio_name, user_id),
      companies(id, name, durc_expiry_date)
    `)
    .eq('status', 'active')
    .not('companies.durc_expiry_date', 'is', null)
    .lte('companies.durc_expiry_date', t30);

  if (error) { console.error('[studioDurcAlert] fetch error:', error.message); return; }
  if (!clients?.length) { console.log('[studioDurcAlert] nessun DURC in scadenza — skip.'); return; }

  // Raggruppa per studio
  const byStudio = {};
  for (const c of clients) {
    const days = daysUntil(c.companies?.durc_expiry_date);
    if (days === null || days > 30) continue;
    const studio  = c.studio_partners;
    if (!studio) continue;
    if (!byStudio[c.studio_id]) {
      byStudio[c.studio_id] = { studio, companies: [] };
    }
    byStudio[c.studio_id].companies.push({
      name:       c.companies?.name || 'Impresa',
      expiryDate: c.companies?.durc_expiry_date,
      days,
    });
  }

  const appUrl = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');

  for (const [studioId, info] of Object.entries(byStudio)) {
    try {
      // Email dallo studio owner (via auth admin)
      const { data: { user } } = await supabase.auth.admin.getUserById(info.studio.user_id);
      const email = user?.email;
      if (!email) { console.warn(`[studioDurcAlert] no email for studio ${studioId}`); continue; }

      await sendStudioDurcAlert({
        to:           email,
        studioName:   info.studio.studio_name,
        companies:    info.companies,
        dashboardUrl: `${appUrl}/studio`,
      });
      console.log(`[studioDurcAlert] studio ${studioId}: alert inviato (${info.companies.length} clienti)`);
    } catch (e) {
      console.error(`[studioDurcAlert] errore studio ${studioId}:`, e.message);
    }
  }

  console.log('[studioDurcAlert] completato.');
}

function startStudioDurcAlertCron() {
  cron.schedule('45 7 * * *', async () => {
    try { await runStudioDurcAlertCheck(); }
    catch (e) { console.error('[studioDurcAlert] errore cron:', e.message); }
  }, { timezone: 'Europe/Rome' });
  console.log('[cron] studio-durc-alert attivo — 07:45 Europe/Rome');
}

module.exports = { startStudioDurcAlertCron, runStudioDurcAlertCheck };
