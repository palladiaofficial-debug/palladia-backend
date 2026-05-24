'use strict';
/**
 * services/siteOccupazioneExpiryCron.js
 * Cron giornaliero (07:20) — scadenze occupazione del suolo pubblico.
 *
 * Scansiona tutti i cantieri con suolo_occupazione = true e suolo_occupazione_end
 * impostata, avvisa l'impresa 30 giorni prima e di nuovo a scadenza.
 *
 * Severity:
 *   info     → scade entro 30 giorni
 *   warning  → scade entro 7 giorni
 *   critical → già scaduta
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const {
  daysUntil, inDays, severityFor, severityLabel,
  upsertNotification, shouldSendTelegram, pruneNotifications,
} = require('./expiryHelper');
const {
  notifyExpiryAlert, notifyResolved,
} = require('./telegramNotifications');

function buildOccupazioneMessage(items) {
  const FRONTEND_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');
  const lines = items.map(s => {
    const icon = s.severity === 'critical' ? '🔴' : '🟡';
    const when = s.days < 0
      ? `scaduta ${Math.abs(s.days)} giorn${Math.abs(s.days) === 1 ? 'o' : 'i'} fa`
      : `scade in ${s.days} giorni`;
    return `${icon} <b>${s.name}</b>\n   Suolo pubblico: ${when}`;
  });
  return (
    `⚠️ <b>PALLADIA — Occupazione suolo</b>\n\n` +
    lines.join('\n\n') +
    `\n\n→ <a href="${FRONTEND_URL}/cantieri">Rinnova l'autorizzazione</a>`
  );
}

async function runOccupazioneExpiryCheck() {
  console.log('[occupazioneExpiry] avvio controllo scadenze suolo...');
  const t30 = inDays(30);

  const { data: sites, error } = await supabase
    .from('sites')
    .select('id, name, company_id, suolo_occupazione_end')
    .eq('suolo_occupazione', true)
    .not('suolo_occupazione_end', 'is', null)
    .lte('suolo_occupazione_end', t30)
    .neq('status', 'eliminato');

  if (error) { console.error('[occupazioneExpiry] fetch error:', error.message); return; }
  if (!sites?.length) { console.log('[occupazioneExpiry] nessuna scadenza — skip.'); return; }

  // Raggruppa per company
  const byCompany = {};
  for (const site of sites) {
    const days = daysUntil(site.suolo_occupazione_end);
    if (days === null) continue;
    if (!byCompany[site.company_id]) byCompany[site.company_id] = [];
    byCompany[site.company_id].push({ ...site, days, severity: severityFor(days) });
  }

  for (const companyId of Object.keys(byCompany)) {
    const items = byCompany[companyId];
    try {
      const relevantIds   = new Set();
      const telegramItems = [];

      for (const site of items) {
        const { isNew, escalated } = await upsertNotification({
          companyId,
          type:       'site_occupazione_expiry',
          severity:   site.severity,
          title:      `Suolo pubblico: ${site.name}`,
          body:       severityLabel(site.days),
          entityType: 'site',
          entityId:   site.id,
        });
        relevantIds.add(site.id);
        if (shouldSendTelegram(site.severity, { isNew, escalated })) {
          telegramItems.push(site);
        }
      }

      // Rimuove notifiche per cantieri che non hanno più scadenza imminente
      const { resolved } = await pruneNotifications(companyId, 'site_occupazione_expiry', 'site', relevantIds);

      if (telegramItems.length) {
        const msg = buildOccupazioneMessage(telegramItems);
        await notifyExpiryAlert(companyId, msg).catch(() => {});
      }
      if (resolved.length) {
        await notifyResolved(companyId, resolved, 'Occupazione suolo aggiornata').catch(() => {});
      }

      console.log(`[occupazioneExpiry] company ${companyId}: ${items.length} scadenze, ${resolved.length} risolte`);
    } catch (err) {
      console.error(`[occupazioneExpiry] errore company ${companyId}:`, err.message);
    }
  }
}

function startSiteOccupazioneExpiryCron() {
  // Ogni giorno alle 07:20 (Europe/Rome) — sfasato rispetto agli altri cron
  cron.schedule('20 7 * * *', async () => {
    try {
      await runOccupazioneExpiryCheck();
    } catch (e) {
      console.error('[occupazioneExpiry] errore cron:', e.message);
    }
  }, { timezone: 'Europe/Rome' });

  console.log('[occupazioneExpiry] scheduler attivo — esecuzione giornaliera alle 07:20 (Europe/Rome)');
}

module.exports = { startSiteOccupazioneExpiryCron, runOccupazioneExpiryCheck };
