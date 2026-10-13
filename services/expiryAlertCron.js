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
const { problemiLavoratori } = require('../lib/documentiStato');

// Calcola giorni rimanenti da oggi. Negativo = già scaduto.
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = String(dateStr).split('T')[0].split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.ceil((target - now) / 86400000);
}

const STATUS = { scaduto: 'expired', in_scadenza: 'expiring' };

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

  // F-354: stato dei lavoratori dalla stessa fonte di /documenti, una volta per azienda
  const problemiByCompany = new Map();
  const problemiDi = async (companyId) => {
    if (!problemiByCompany.has(companyId)) problemiByCompany.set(companyId, await problemiLavoratori(companyId));
    return problemiByCompany.get(companyId);
  };

  for (const email of emails) {
    try {
      // 2. Trova tutti gli inviti attivi per questa email
      const { data: invites, error: invErr } = await supabase
        .from('site_coordinator_invites')
        .select('id, site_id, company_id, coordinator_name')
        .eq('coordinator_email', email)
        .eq('is_active', true)
        .gt('expires_at', new Date().toISOString());
      if (invErr) throw new Error(`inviti: ${invErr.message}`);

      if (!invites?.length) continue;

      const siteIds = [...new Set(invites.map(i => i.site_id))];

      // 3. Recupera nome cantieri
      const { data: sites, error: sitesErr } = await supabase
        .from('sites')
        .select('id, name, address')
        .in('id', siteIds);
      if (sitesErr) throw new Error(`cantieri: ${sitesErr.message}`);

      const siteMap = Object.fromEntries((sites || []).map(s => [s.id, s]));

      // 4. Per ogni cantiere, controlla i lavoratori
      const sitesWithIssues = [];

      for (const invite of invites) {
        const { data: ww, error: wwErr } = await supabase
          .from('worksite_workers')
          .select('worker_id')
          .eq('site_id', invite.site_id)
          .eq('company_id', invite.company_id)
          .eq('status', 'active');
        if (wwErr) throw new Error(`lavoratori del cantiere: ${wwErr.message}`);

        if (!ww?.length) continue;

        const onSite = new Set(ww.map(r => r.worker_id));
        const { scadenze } = await problemiDi(invite.company_id);
        const byWorker = new Map();
        for (const x of scadenze) {
          if (!onSite.has(x.workerId) || !x.key) continue; // solo visita e corso, come prima
          if (!byWorker.has(x.workerId)) byWorker.set(x.workerId, { name: x.name });
          const w = byWorker.get(x.workerId);
          const pre = x.key === 'formazione' ? 'safety' : 'health';
          w[`${pre}_expiry`] = x.expiry;
          w[`${pre}_status`] = STATUS[x.state];
          w[`${pre}_days`] = daysUntil(x.expiry);
        }
        const issues = [...byWorker.values()].map(w => ({
          safety_expiry: null, health_expiry: null, safety_status: null, health_status: null,
          safety_days: null, health_days: null, ...w,
        }));

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
