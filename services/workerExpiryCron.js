'use strict';
/**
 * services/workerExpiryCron.js
 *
 * Cron giornaliero (07:15 Europe/Rome) — avvisa i responsabili aziendali
 * (owner/admin/tech) quando i documenti dei propri lavoratori scadono entro 30 giorni.
 *
 * Diverso da expiryAlertCron.js (settimanale, per i coordinatori Pro esterni):
 * questo è rivolto all'impresa stessa per i propri organici.
 *
 * Non invia se nessun documento è in scadenza.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { sendWorkerExpiryAlertCompany } = require('./email');

function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - Date.now()) / 86400000);
}

async function runWorkerExpiryCheck() {
  console.log('[workerExpiry] avvio controllo scadenze lavoratori...');

  // 1. Trova tutti i lavoratori attivi con almeno un documento in scadenza ≤ 30 giorni
  //    Usiamo una finestra: scade tra oggi e +30 giorni (escludiamo già scaduti > 30gg)
  const today = new Date().toISOString().split('T')[0];
  const in30  = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

  const { data: workers, error } = await supabase
    .from('workers')
    .select('id, company_id, full_name, safety_training_expiry, health_fitness_expiry')
    .eq('is_active', true)
    .or(
      `safety_training_expiry.lte.${in30},health_fitness_expiry.lte.${in30}`
    );

  if (error) {
    console.error('[workerExpiry] errore fetch workers:', error.message);
    return;
  }

  if (!workers?.length) {
    console.log('[workerExpiry] nessuna scadenza imminente — skip.');
    return;
  }

  // 2. Raggruppa per company
  const byCompany = {};
  for (const w of workers) {
    const safetyDays = daysUntil(w.safety_training_expiry);
    const healthDays = daysUntil(w.health_fitness_expiry);

    // Includi solo se almeno un doc scade entro 30 giorni (anche già scaduto)
    const safetyRelevant = safetyDays !== null && safetyDays <= 30;
    const healthRelevant = healthDays !== null && healthDays <= 30;
    if (!safetyRelevant && !healthRelevant) continue;

    if (!byCompany[w.company_id]) byCompany[w.company_id] = [];
    byCompany[w.company_id].push({
      name:           w.full_name,
      safety_expiry:  safetyRelevant ? w.safety_training_expiry : null,
      health_expiry:  healthRelevant ? w.health_fitness_expiry  : null,
      safety_days:    safetyRelevant ? safetyDays : null,
      health_days:    healthRelevant ? healthDays : null,
      safety_status:  safetyRelevant ? (safetyDays < 0 ? 'expired' : 'expiring') : null,
      health_status:  healthRelevant ? (healthDays < 0 ? 'expired' : 'expiring') : null,
    });
  }

  const companyIds = Object.keys(byCompany);
  if (!companyIds.length) {
    console.log('[workerExpiry] nessuna scadenza rilevante — skip.');
    return;
  }

  console.log(`[workerExpiry] ${companyIds.length} company con scadenze imminenti`);

  // 3. Per ogni company, recupera email degli admin e invia
  for (const companyId of companyIds) {
    try {
      // Recupera email di owner/admin/tech con auth.users via company_users
      const { data: members } = await supabase
        .from('company_users')
        .select('user_id, role')
        .eq('company_id', companyId)
        .in('role', ['owner', 'admin', 'tech']);

      if (!members?.length) continue;

      // Recupera le email da auth.users (service_role)
      const emails = [];
      for (const m of members) {
        const { data: { user } } = await supabase.auth.admin.getUserById(m.user_id);
        if (user?.email) emails.push(user.email);
      }

      if (!emails.length) continue;

      // Recupera nome company
      const { data: company } = await supabase
        .from('companies')
        .select('name')
        .eq('id', companyId)
        .single();

      await sendWorkerExpiryAlertCompany({
        to:          emails,
        companyName: company?.name || 'la tua impresa',
        workers:     byCompany[companyId],
        dashboardUrl: (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '') + '/risorse',
      });

      console.log(`[workerExpiry] company ${companyId}: email inviata a ${emails.length} destinatari — ${byCompany[companyId].length} lavoratori`);
    } catch (e) {
      console.error(`[workerExpiry] errore company ${companyId}:`, e.message);
    }
  }

  console.log('[workerExpiry] completato.');
}

function startWorkerExpiryCron() {
  // Ogni giorno alle 07:15 Europe/Rome (prima del daily summary delle 07:30)
  cron.schedule('15 7 * * *', async () => {
    try { await runWorkerExpiryCheck(); }
    catch (e) { console.error('[workerExpiry] errore cron:', e.message); }
  }, { timezone: 'Europe/Rome' });

  console.log('[cron] worker-expiry scheduler attivo — esecuzione ogni giorno alle 07:15 (Europe/Rome)');
}

module.exports = { startWorkerExpiryCron, runWorkerExpiryCheck };
