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

/**
 * Aperture (ENTRY senza EXIT) di UNA company piu vecchie di `ageHours`.
 * Estratta da runIntraDayCheck per poter essere testata da sola.
 */
async function findStaleOpenEntries(companyId, date, ageHours) {
  const cutoff = Date.now() - ageHours * 3_600_000;

  // F-206 (AUDIT.md): nessun embed `site:sites(...)` — la FK
  // presence_logs.site_id -> sites(id) non esiste piu in produzione e
  // l'intera query veniva rifiutata da PostgREST, rendendo muti gli alert
  // delle 12/14/16/18 senza lasciare traccia. Vedi checkCompany() in
  // services/missingExitCron.js per la stessa correzione.
  const { data: logs, error } = await supabase
    .from('presence_logs')
    .select(`
      worker_id, event_type, timestamp_server, site_id,
      worker:workers (id, full_name)
    `)
    .eq('company_id', companyId)
    .gte('timestamp_server', `${date}T00:00:00+02:00`)
    .lte('timestamp_server', `${date}T23:59:59+01:00`)
    .order('timestamp_server', { ascending: true })
    .limit(10000);

  if (error) throw new Error(`findStaleOpenEntries(${companyId}): ${error.message}`);
  if (!logs?.length) return [];

  // Apertura globale per lavoratore, non per (lavoratore, cantiere) — vedi
  // migrazione 201 / F-172 e il commento in checkCompany().
  const lastByWorker = new Map();
  for (const log of logs) lastByWorker.set(log.worker_id, log);

  const open = [];
  for (const [, log] of lastByWorker) {
    if (log.event_type !== 'ENTRY') continue;
    if (new Date(log.timestamp_server).getTime() > cutoff) continue;
    open.push(log);
  }
  if (!open.length) return [];

  const { data: sites, error: sitesErr } = await supabase
    .from('sites')
    .select('id, name')
    .in('id', [...new Set(open.map(l => l.site_id))]);
  if (sitesErr) throw new Error(`findStaleOpenEntries(${companyId}) sites: ${sitesErr.message}`);
  const siteById = new Map((sites || []).map(s => [s.id, s]));

  return open.map(log => ({
    worker_id:       log.worker_id,
    worker_name:     log.worker?.full_name || null,
    site_id:         log.site_id,
    site_name:       siteById.get(log.site_id)?.name || 'Cantiere',
    last_entry_time: log.timestamp_server,
  }));
}

async function runIntraDayCheck() {
  resetIfNewDay();
  const date = lastResetDate;

  console.log(`[cron-intraday] check uscite mancanti - ${date} (entry > ${ENTRY_AGE_HOURS}h fa)`);

  const { data: companies, error } = await supabase
    .from('presence_logs')
    .select('company_id')
    .gte('timestamp_server', `${date}T00:00:00+02:00`)
    .lte('timestamp_server', `${date}T23:59:59+01:00`);

  if (error || !companies?.length) return;

  const companyIds = [...new Set(companies.map(r => r.company_id))];

  for (const companyId of companyIds) {
    try {
      const stale = await findStaleOpenEntries(companyId, date, ENTRY_AGE_HOURS);

      const bySite = new Map();
      for (const entry of stale) {
        const dedupeKey = `${companyId}::${entry.worker_id}::${entry.site_id}`;
        if (notifiedToday.has(dedupeKey)) continue;
        notifiedToday.add(dedupeKey);

        if (!bySite.has(entry.site_id)) bySite.set(entry.site_id, { siteName: entry.site_name, workerNames: [] });
        if (entry.worker_name) bySite.get(entry.site_id).workerNames.push(entry.worker_name);
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

module.exports = { startMissingExitIntraDayCron, findStaleOpenEntries };
