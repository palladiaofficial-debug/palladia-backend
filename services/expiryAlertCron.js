'use strict';
/**
 * services/expiryAlertCron.js
 * Cron settimanale (lunedì mattina) — notifica i professionisti dei documenti
 * in scadenza nei cantieri che coordinano.
 *
 * Logica:
 * 1. Ogni lunedì alle 08:00 (Europe/Rome) scansiona coordinator_pro_sessions attive.
 * 2. Per ogni email unica, trova i cantieri accessibili (inviti attivi, non scaduti).
 * 3. Per ogni cantiere, controlla i lavoratori con documenti in scadenza (≤ 30 giorni).
 * 4. Se trova anomalie → invia email riepilogativa al professionista.
 *
 * Usa node-cron (già in produzione per missingExitCron) — persistente ai restart.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { sendExpiryAlertPro } = require('./email');

// Calcola giorni rimanenti da oggi. Negativo = già scaduto.
function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - Date.now()) / 86400000);
}

function complianceLabel(days) {
  if (days === null)  return null; // non impostata — non la segnaliamo
  if (days < 0)       return 'expired';
  if (days <= 30)     return 'expiring';
  return null;
}

/**
 * Esegue il controllo completo e invia le email.
 * Chiamata sia dal cron che dall'endpoint di test.
 */
async function runExpiryAlerts() {
  console.log('[expiryAlert] avvio scansione scadenze...');

  // 1. Prendi tutte le sessioni Pro attive
  const { data: sessions, error: sessErr } = await supabase
    .from('coordinator_pro_sessions')
    .select('email')
    .gt('expires_at', new Date().toISOString());

  if (sessErr || !sessions?.length) {
    console.log('[expiryAlert] nessuna sessione Pro attiva — skip.');
    return;
  }

  // Email univoche
  const emails = [...new Set(sessions.map(s => s.email))];
  let emailsSent = 0;

  for (const email of emails) {
    try {
      // 2. Trova tutti gli inviti attivi per questa email
      const { data: invites } = await supabase
        .from('site_coordinator_invites')
        .select('id, site_id, company_id, coordinator_name')
        .eq('coordinator_email', email)
        .eq('is_active', true)
        .gt('expires_at', new Date().toISOString());

      if (!invites?.length) continue;

      const siteIds = [...new Set(invites.map(i => i.site_id))];

      // 3. Recupera nome cantieri
      const { data: sites } = await supabase
        .from('sites')
        .select('id, name, address')
        .in('id', siteIds);

      const siteMap = Object.fromEntries((sites || []).map(s => [s.id, s]));

      // 4. Per ogni cantiere, controlla i lavoratori
      const sitesWithIssues = [];

      for (const invite of invites) {
        const { data: ww } = await supabase
          .from('worksite_workers')
          .select('worker_id')
          .eq('site_id', invite.site_id)
          .eq('company_id', invite.company_id)
          .eq('status', 'active');

        if (!ww?.length) continue;

        const workerIds = ww.map(r => r.worker_id);
        const { data: workers } = await supabase
          .from('workers')
          .select('id, full_name, safety_training_expiry, health_fitness_expiry')
          .in('id', workerIds)
          .eq('is_active', true);

        const issues = [];
        for (const w of (workers || [])) {
          const safetyDays = daysUntil(w.safety_training_expiry);
          const healthDays = daysUntil(w.health_fitness_expiry);

          const safetyLabel = complianceLabel(safetyDays);
          const healthLabel = complianceLabel(healthDays);

          if (safetyLabel || healthLabel) {
            issues.push({
              name:           w.full_name,
              safety_expiry:  w.safety_training_expiry,
              health_expiry:  w.health_fitness_expiry,
              safety_status:  safetyLabel,
              health_status:  healthLabel,
              safety_days:    safetyDays,
              health_days:    healthDays,
            });
          }
        }

        if (issues.length > 0) {
          const site = siteMap[invite.site_id];
          sitesWithIssues.push({
            siteName: site?.name || site?.address || 'Cantiere',
            workers:  issues,
          });
        }
      }

      if (sitesWithIssues.length === 0) continue;

      // 5. Recupera profilo per nome
      const { data: profile } = await supabase
        .from('coordinator_profiles')
        .select('full_name')
        .eq('email', email)
        .maybeSingle();

      await sendExpiryAlertPro({
        to:              email,
        coordinatorName: profile?.full_name || email,
        sitesWithIssues,
      });

      emailsSent++;
      console.log(`[expiryAlert] email inviata a ${email} — ${sitesWithIssues.length} cantieri con scadenze`);
    } catch (err) {
      console.error(`[expiryAlert] errore per ${email}:`, err.message);
    }
  }

  console.log(`[expiryAlert] completato — ${emailsSent}/${emails.length} email inviate.`);
}

/**
 * Avvia il cron settimanale con node-cron.
 * Ogni lunedì alle 08:00 (Europe/Rome) — resistente ai restart.
 */
function startExpiryAlertCron() {
  // '0 8 * * 1' = ogni lunedì alle 08:00
  cron.schedule('0 8 * * 1', async () => {
    try {
      await runExpiryAlerts();
    } catch (e) {
      console.error('[expiryAlert] errore cron:', e.message);
    }
  }, {
    timezone: 'Europe/Rome',
  });

  console.log('[expiryAlert] scheduler attivo — esecuzione ogni lunedì alle 08:00 (Europe/Rome)');
}

module.exports = { startExpiryAlertCron, runExpiryAlerts };
