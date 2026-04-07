'use strict';
/**
 * services/missingExitCron.js
 *
 * Cron giornaliero (20:00 Rome) — gestione uscite mancanti.
 *
 * LIVELLO 1 — AUTO EXECUTE:
 *   Ladia registra automaticamente le uscite senza richiedere conferma.
 *   Invia poi una notifica: "Ho già sistemato X uscite su cantiere Y".
 *   L'utente non deve fare nulla.
 *
 * Logica:
 *   1. Trova tutti i lavoratori con ENTRY senza EXIT nel giorno corrente
 *   2. Registra automaticamente EXIT alle 18:00 con method='ladia_action'
 *   3. Invia email admin + Telegram di conferma (nessun bottone)
 *
 * Avvio: chiamare startMissingExitCron() da server.js al boot.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { sendMissingExitAlert }                = require('./email');
const { notifyAutoExec }                      = require('./telegramNotifications');
const { registerMissingExits }                = require('./ladiaActions');

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

  let totalAutoFixed = 0;

  for (const companyId of companyIds) {
    try {
      const missing = await checkCompany(companyId, date);
      if (!missing.length) continue;

      totalAutoFixed += missing.length;

      // Email admin (audit trail — manteniamo sempre)
      await sendMissingExitAlert({ companyId, date, missingList: missing });
      console.log(`[cron] company ${companyId}: ${missing.length} uscite mancanti — auto-fix avviato`);

      // Raggruppa per cantiere
      const bySite = new Map();
      for (const m of missing) {
        const siteId = m.site_id;
        const name   = m.site_name || m.site_address || 'Cantiere';
        if (!bySite.has(siteId)) bySite.set(siteId, { siteName: name, workerNames: [] });
        if (m.worker_name) bySite.get(siteId).workerNames.push(m.worker_name);
      }

      // LIVELLO 1 — AUTO EXECUTE per ogni cantiere, poi notifica unica aggregata
      const fixedSites = [];

      for (const [siteId, { siteName, workerNames }] of bySite.entries()) {
        const result = await registerMissingExits(siteId, date, companyId, null);

        if (!result.ok) {
          console.error(`[cron] auto-fix fallito per site ${siteId} — skip`);
          continue;
        }

        fixedSites.push({ siteName, workerNames, count: result.count });
        console.log(`[cron] auto-fix OK — site ${siteId}: ${result.count} uscite registrate`);
      }

      // Notifica unica per tutta la company (un solo messaggio con tutti i cantieri)
      if (fixedSites.length > 0) {
        const totalCount = fixedSites.reduce((s, x) => s + x.count, 0);

        let confirmText =
          `✅ <b>Uscite registrate automaticamente</b>\n\n` +
          `Ho chiuso ${totalCount} uscit${totalCount > 1 ? 'e' : 'a'} mancant${totalCount > 1 ? 'i' : 'a'} ` +
          `su ${fixedSites.length} cantier${fixedSites.length > 1 ? 'i' : 'e'}:\n`;

        for (const { siteName, workerNames, count } of fixedSites) {
          confirmText += `\n<b>${siteName}</b> (${count}):\n`;
          confirmText += workerNames.slice(0, 6).map(n => `• ${n}`).join('\n');
          if (workerNames.length > 6) confirmText += `\n…e altri ${workerNames.length - 6}`;
          confirmText += '\n';
        }

        confirmText += `\n<i>Log marcati come ladia_action — verificabili su Palladia.</i>`;

        await notifyAutoExec(companyId, confirmText).catch(() => {});
        console.log(`[cron] notifica aggregata inviata — ${totalCount} uscite su ${fixedSites.length} cantieri`);
      }

    } catch (e) {
      console.error(`[cron] errore company ${companyId}:`, e.message);
    }
  }

  console.log(`[cron] completato — ${totalAutoFixed} uscite gestite automaticamente`);
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
