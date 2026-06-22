'use strict';
/**
 * services/missingExitIntraDayCron.js
 *
 * Check intra-giornaliero per uscite mancanti.
 * Gira ogni 2 ore durante l'orario di lavoro (12, 14, 16, 18).
 * NON auto-registra le uscite (quello lo fa il cron delle 20:00).
 * Manda solo alert Telegram + push al capocantiere/admin.
 *
 * Deduplicazione: tiene traccia in memoria dei worker già notificati
 * per evitare spam. Reset giornaliero automatico.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { notifyMissingExitsWithAction } = require('./telegramNotifications');

const ENTRY_AGE_HOURS = 8;

// worker già notificati oggi: Set<"companyId::workerId::siteId">
let notifiedToday = new Set();
let lastResetDate = '';

function resetIfNewDay() {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  if (today !== lastResetDate) {
    notifiedToday = new Set();
    lastResetDate = today;
  }
}

async function runIntraDayCheck() {
  resetIfNewDay();
  const date = lastResetDate;
  const now  = Date.now();
  const cutoff = now - ENTRY_AGE_HOURS * 3_600_000;

  console.log(`[cron-intraday] check uscite mancanti — ${date} (entry > ${ENTRY_AGE_HOURS}h fa)`);

  const { data: companies, error } = await supabase
    .from('presence_logs')
    .select('company_id')
    .gte('timestamp_server', `${date}T00:00:00+02:00`)
    .lte('timestamp_server', `${date}T23:59:59+01:00`);

  if (error || !companies?.length) return;

  const companyIds = [...new Set(companies.map(r => r.company_id))];

  for (const companyId of companyIds) {
    try {
      const { data: logs } = await supabase
        .from('presence_logs')
        .select(`
          worker_id, event_type, timestamp_server, site_id,
          worker:workers (id, full_name),
          site:sites (id, name)
        `)
        .eq('company_id', companyId)
        .gte('timestamp_server', `${date}T00:00:00+02:00`)
        .lte('timestamp_server', `${date}T23:59:59+01:00`)
        .order('timestamp_server', { ascending: true })
        .limit(10000);

      if (!logs?.length) continue;

      const lastByKey = new Map();
      for (const log of logs) {
        lastByKey.set(`${log.worker_id}::${log.site_id}`, log);
      }

      const bySite = new Map();
      for (const [, log] of lastByKey) {
        if (log.event_type !== 'ENTRY') continue;

        const entryTime = new Date(log.timestamp_server).getTime();
        if (entryTime > cutoff) continue;

        const dedupeKey = `${companyId}::${log.worker_id}::${log.site_id}`;
        if (notifiedToday.has(dedupeKey)) continue;

        notifiedToday.add(dedupeKey);

        const siteId   = log.site_id;
        const siteName = log.site?.name || 'Cantiere';
        if (!bySite.has(siteId)) bySite.set(siteId, { siteName, workerNames: [] });
        if (log.worker?.full_name) bySite.get(siteId).workerNames.push(log.worker.full_name);
      }

      for (const [siteId, { siteName, workerNames }] of bySite) {
        if (!workerNames.length) continue;
        console.log(`[cron-intraday] ${companyId} / ${siteName}: ${workerNames.length} uscite mancanti (>${ENTRY_AGE_HOURS}h)`);
        await notifyMissingExitsWithAction(companyId, siteId, siteName, workerNames, date)
          .catch(e => console.error('[cron-intraday] notify error:', e.message));
      }

    } catch (e) {
      console.error(`[cron-intraday] errore company ${companyId}:`, e.message);
    }
  }
}

function startMissingExitIntraDayCron() {
  cron.schedule('0 12,14,16,18 * * 1-6', runIntraDayCheck, {
    timezone: 'Europe/Rome',
  });
  console.log('[cron] missing-exit INTRA-DAY attivo — 12/14/16/18 lun-sab (Europe/Rome)');
}

module.exports = { startMissingExitIntraDayCron };
