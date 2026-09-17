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
const { getCompanyTelegramUsers }             = require('./telegramNotifications');
const tg                                      = require('./telegram');
const { registerMissingExits }                = require('./ladiaActions');

// ── Helper: trova uscite mancanti per una company, guardando indietro fino a
//    BACKFILL_DAYS giorni ─────────────────────────────────────────────────────
//
// F-043 (AUDIT.md): prima guardava SOLO il giorno corrente — un'ENTRY che il
// cron non riusciva a chiudere lo stesso giorno (cron fallito, server giù,
// errore silenzioso) diventava invisibile per sempre ai run successivi,
// finché il lavoratore non ritimbrava e il tocco veniva erroneamente
// abbinato come EXIT di quel turno vecchio (vedi anche il fix in
// punch_atomic, migrazione 161). Guardando indietro su una finestra di
// giorni si dà al cron la possibilità di recuperare un'entrata rimasta
// aperta anche se il run del giorno stesso è saltato.
const BACKFILL_DAYS = 7;

async function checkCompany(companyId, date) {
  const rangeStart = new Date(`${date}T00:00:00.000Z`);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - (BACKFILL_DAYS - 1));

  // F-206 (AUDIT.md): NIENTE embed `site:sites(...)` qui. La FK
  // presence_logs.site_id -> sites(id) non esiste piu nel DB di produzione
  // (872 site_id puntano a cantieri cancellati; ripristinarla romperebbe
  // l'append-only di presence_logs), quindi PostgREST rifiutava l'intera
  // query con "Could not find a relationship ... in the schema cache" e
  // questa funzione restituiva [] -> "nessuna uscita mancante" per OGNI
  // azienda, ogni giorno. Il nome del cantiere si risolve con una query
  // separata su sites: nessuna dipendenza da una FK che puo sparire.
  const { data: logs, error } = await supabase
    .from('presence_logs')
    .select(`
      worker_id, event_type, timestamp_server, site_id,
      worker:workers (id, full_name, fiscal_code)
    `)
    .eq('company_id', companyId)
    .gte('timestamp_server', rangeStart.toISOString())
    .lte('timestamp_server', `${date}T23:59:59.999Z`)
    .order('timestamp_server', { ascending: true })
    .limit(10000);

  // Un errore di query NON deve piu degradare a "nessuna uscita mancante":
  // e' esattamente cosi che il bug e' rimasto invisibile. Chi chiama lo
  // registra come errore della singola company e prosegue con le altre.
  if (error) throw new Error(`checkCompany(${companyId}): ${error.message}`);
  if (!logs?.length) return [];

  // Ultimo evento per LAVORATORE in tutta l'azienda, non per (lavoratore,
  // cantiere): dalla migrazione 201 (F-172) punch_atomic garantisce una sola
  // apertura per lavoratore in tutta la company, e l'uscita viene taggata sul
  // cantiere dove l'entrata era aperta anche se il lavoratore tocca un altro
  // cantiere. Con la vecchia chiave per-cantiere un'entrata gia chiusa
  // altrove sarebbe risultata ancora aperta.
  const lastByWorker = new Map();
  for (const log of logs) {
    lastByWorker.set(log.worker_id, log);
  }

  const open = [];
  for (const [, log] of lastByWorker) {
    if (log.event_type === 'ENTRY') open.push(log);
  }
  if (!open.length) return [];

  const siteIds = [...new Set(open.map(l => l.site_id))];
  const { data: sites, error: sitesErr } = await supabase
    .from('sites')
    .select('id, name, address')
    .in('id', siteIds);
  if (sitesErr) throw new Error(`checkCompany(${companyId}) sites: ${sitesErr.message}`);
  const siteById = new Map((sites || []).map(s => [s.id, s]));

  return open.map(log => ({
    worker_id:       log.worker?.id || log.worker_id,
    worker_name:     log.worker?.full_name,
    fiscal_code:     log.worker?.fiscal_code,
    site_id:         log.site_id,
    site_name:       siteById.get(log.site_id)?.name,
    site_address:    siteById.get(log.site_id)?.address,
    last_entry_time: log.timestamp_server,
  }));
}

// ── Job principale ────────────────────────────────────────────────────────────
async function runMissingExitCheck() {
  // Data odierna in Europe/Rome
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  console.log(`[cron] missing-exits check — ${date}`);

  // Recupera tutte le company che hanno almeno un log nella finestra di
  // backfill (non solo oggi — altrimenti una company senza timbrature oggi
  // ma con un'entrata rimasta aperta da giorni non verrebbe mai controllata).
  const rangeStart = new Date(`${date}T00:00:00.000Z`);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - (BACKFILL_DAYS - 1));
  const { data: companies, error } = await supabase
    .from('presence_logs')
    .select('company_id')
    .gte('timestamp_server', rangeStart.toISOString())
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

      // Email admin (audit trail — manteniamo sempre). Isolata: e' un
      // effetto secondario, un fallimento di Resend non deve impedire la
      // registrazione automatica delle uscite qui sotto (F-206).
      await sendMissingExitAlert({ companyId, date, missingList: missing })
        .catch(e => console.error(`[cron] email uscite mancanti fallita (company ${companyId}):`, e.message));
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

        fixedSites.push({ siteId, siteName, workerNames, count: result.count });
        console.log(`[cron] auto-fix OK — site ${siteId}: ${result.count} uscite registrate`);
      }

      // Notifica per-utente: ognuno vede solo i cantieri che gli competono
      if (fixedSites.length > 0) {
        const tgUsers = await getCompanyTelegramUsers(companyId);

        for (const { chatId, allowedSiteIds } of tgUsers) {
          // Filtra i cantieri visibili a questo utente
          const userSites = allowedSiteIds === null
            ? fixedSites
            : fixedSites.filter(x => allowedSiteIds.includes(x.siteId));

          if (!userSites.length) continue;

          const totalCount = userSites.reduce((s, x) => s + x.count, 0);
          let confirmText =
            `✅ <b>Uscite registrate automaticamente</b>\n\n` +
            `Ho chiuso ${totalCount} uscit${totalCount > 1 ? 'e' : 'a'} mancant${totalCount > 1 ? 'i' : 'a'} ` +
            `su ${userSites.length} cantier${userSites.length > 1 ? 'i' : 'e'}:\n`;

          for (const { siteName, workerNames, count } of userSites) {
            confirmText += `\n<b>${siteName}</b> (${count}):\n`;
            confirmText += workerNames.slice(0, 6).map(n => `• ${n}`).join('\n');
            if (workerNames.length > 6) confirmText += `\n…e altri ${workerNames.length - 6}`;
            confirmText += '\n';
          }
          confirmText += `\n<i>Log marcati come ladia_action — verificabili su Palladia.</i>`;

          await tg.sendMessage(chatId, confirmText).catch(() => {});
        }

        const totalCount = fixedSites.reduce((s, x) => s + x.count, 0);
        console.log(`[cron] notifiche per-utente inviate — ${totalCount} uscite su ${fixedSites.length} cantieri`);
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

module.exports = { startMissingExitCron, runMissingExitCheck, checkCompany };
