'use strict';
/**
 * services/missingExitCron.js
 *
 * Cron giornaliero che controlla le uscite mancanti per TUTTE le company attive
 * e invia un'email agli admin di ogni company che ha anomalie.
 *
 * Orario: ogni giorno alle 20:00 ora italiana (Europe/Rome).
 * In produzione Railway usa UTC → le 20:00 Rome = 19:00 UTC (inverno) / 18:00 UTC (estate).
 * node-cron supporta timezone nativamente → usiamo quello.
 *
 * Avvio: chiamare startMissingExitCron() da server.js al boot.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { sendMissingExitAlert } = require('./email');
const { notifyMissingExitsWithAction } = require('./telegramNotifications');

// ── Helper: trova uscite mancanti per una company in una data ─────────────────
async function checkCompany(companyId, date) {
  const { data: logs, error } = await supabase
    .from('presence_logs')
    .select(`
      worker_id, event_type, timestamp_server, site_id,
      worker:workers (id, full_name, fiscal_code),
      site:sites (id, name, address)
    `)
    .eq('company_id', companyId)
    .gte('timestamp_server', `${date}T00:00:00.000Z`)
    .lte('timestamp_server', `${date}T23:59:59.999Z`)
    .order('timestamp_server', { ascending: true })
    .limit(10000);

  if (error || !logs?.length) return [];

  // Ultimo evento per coppia (worker, site) — se è ENTRY → uscita mancante
  const lastByKey = new Map();
  for (const log of logs) {
    lastByKey.set(`${log.worker_id}::${log.site_id}`, log);
  }

  const missing = [];
  for (const [, log] of lastByKey) {
    if (log.event_type === 'ENTRY') {
      missing.push({
        worker_id:       log.worker?.id,
        worker_name:     log.worker?.full_name,
        fiscal_code:     log.worker?.fiscal_code,
        site_id:         log.site_id,
        site_name:       log.site?.name,
        site_address:    log.site?.address,
        last_entry_time: log.timestamp_server
      });
    }
  }
  return missing;
}

// ── Job principale ────────────────────────────────────────────────────────────
async function runMissingExitCheck() {
  // Data odierna in Europe/Rome
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  console.log(`[cron] missing-exits check — ${date}`);

  // Recupera tutte le company che hanno almeno un log oggi
  const { data: companies, error } = await supabase
    .from('presence_logs')
    .select('company_id')
    .gte('timestamp_server', `${date}T00:00:00.000Z`)
    .lte('timestamp_server', `${date}T23:59:59.999Z`);

  if (error) {
    console.error('[cron] errore fetch companies:', error.message);
    return;
  }

  // Deduplica company_id
  const companyIds = [...new Set((companies || []).map(r => r.company_id))];
  if (companyIds.length === 0) {
    console.log('[cron] nessuna timbratura oggi — skip');
    return;
  }

  console.log(`[cron] ${companyIds.length} company con timbrature oggi`);

  let totalAlerts = 0;
  for (const companyId of companyIds) {
    try {
      const missing = await checkCompany(companyId, date);
      if (missing.length > 0) {
        // Email admin
        await sendMissingExitAlert({ companyId, date, missingList: missing });
        totalAlerts += missing.length;
        console.log(`[cron] company ${companyId}: ${missing.length} uscite mancanti — email inviata`);

        // Telegram: raggruppa per cantiere e notifica con bottone azione
        const bySite = new Map();
        for (const m of missing) {
          const siteId = m.site_id;
          const name   = m.site_name || m.site_address || 'Cantiere';
          if (!bySite.has(siteId)) bySite.set(siteId, { siteName: name, workers: [] });
          if (m.worker_name) bySite.get(siteId).workers.push(m.worker_name);
        }
        for (const [siteId, { siteName, workers }] of bySite.entries()) {
          notifyMissingExitsWithAction(companyId, siteId, siteName, workers, date).catch(() => {});
        }
      }
    } catch (e) {
      console.error(`[cron] errore company ${companyId}:`, e.message);
    }
  }

  console.log(`[cron] completato — ${totalAlerts} uscite mancanti totali`);
}

// ── Registra il cron ──────────────────────────────────────────────────────────
function startMissingExitCron() {
  // Ogni giorno alle 20:00 ora italiana
  // Sintassi: secondi(opt) minuti ore giornoMese mese giornoSettimana
  cron.schedule('0 20 * * *', runMissingExitCheck, {
    timezone: 'Europe/Rome'
  });

  console.log('[cron] missing-exit scheduler attivo — esecuzione ogni giorno alle 20:00 (Europe/Rome)');
}

module.exports = { startMissingExitCron, runMissingExitCheck };
