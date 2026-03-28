'use strict';
/**
 * services/dailySummaryCron.js
 *
 * Cron mattutino: ogni giorno alle 07:30 (Europe/Rome) invia un riepilogo
 * di ieri via Telegram a tutti gli utenti collegati di ogni company attiva.
 *
 * Il riepilogo include, per ogni cantiere con attività ieri:
 *   - Numero di lavoratori che hanno timbrato
 *   - Numero di note archiviate
 *   - Numero di non conformità aperte
 *
 * Non invia se non c'è stata alcuna attività (week-end, festivi, ecc.).
 *
 * Avvio: chiamare startDailySummaryCron() da server.js al boot.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { notifyCompany } = require('./telegramNotifications');

// ── Job principale ────────────────────────────────────────────────────────────

async function runDailySummary() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });

  console.log(`[dailySummary] avvio riepilogo per ${dateStr}`);

  // Company che hanno almeno un utente Telegram collegato
  const { data: tuUsers, error: tuErr } = await supabase
    .from('telegram_users')
    .select('company_id')
    .limit(1000);

  if (tuErr) {
    console.error('[dailySummary] errore fetch telegram_users:', tuErr.message);
    return;
  }

  const companyIds = [...new Set((tuUsers || []).map(u => u.company_id))];
  if (!companyIds.length) {
    console.log('[dailySummary] nessun utente Telegram collegato — skip');
    return;
  }

  console.log(`[dailySummary] ${companyIds.length} company con Telegram`);

  for (const companyId of companyIds) {
    try {
      await sendCompanySummary(companyId, dateStr, yesterday);
    } catch (e) {
      console.error(`[dailySummary] errore company ${companyId}:`, e.message);
    }
  }

  console.log('[dailySummary] completato');
}

async function sendCompanySummary(companyId, dateStr, yesterday) {
  // Siti attivi della company
  const { data: sites } = await supabase
    .from('sites')
    .select('id, name, address')
    .eq('company_id', companyId)
    .neq('status', 'chiuso')
    .limit(30);

  if (!sites?.length) return;

  const siteIds = sites.map(s => s.id);

  // Timbrature di ieri (worker distinti per cantiere)
  const { data: presences } = await supabase
    .from('presence_logs')
    .select('site_id, worker_id')
    .eq('company_id', companyId)
    .gte('timestamp_server', `${dateStr}T00:00:00.000Z`)
    .lte('timestamp_server', `${dateStr}T23:59:59.999Z`)
    .in('site_id', siteIds)
    .limit(5000);

  // Note di ieri per cantiere
  const { data: notes } = await supabase
    .from('site_notes')
    .select('site_id')
    .eq('company_id', companyId)
    .gte('created_at', `${dateStr}T00:00:00.000Z`)
    .lte('created_at', `${dateStr}T23:59:59.999Z`)
    .in('site_id', siteIds)
    .limit(5000);

  // NC aperte (non risolte) per cantiere
  const { data: openNcs } = await supabase
    .from('site_notes')
    .select('site_id')
    .eq('company_id', companyId)
    .eq('category', 'non_conformita')
    .in('site_id', siteIds)
    .limit(500);

  // Aggrega per cantiere
  const workersBySite = {};
  for (const p of presences || []) {
    if (!workersBySite[p.site_id]) workersBySite[p.site_id] = new Set();
    workersBySite[p.site_id].add(p.worker_id);
  }

  const notesBySite = {};
  for (const n of notes || []) {
    notesBySite[n.site_id] = (notesBySite[n.site_id] || 0) + 1;
  }

  const ncBySite = {};
  for (const nc of openNcs || []) {
    ncBySite[nc.site_id] = (ncBySite[nc.site_id] || 0) + 1;
  }

  // Costruisce le righe solo per cantieri con attività ieri
  const lines = [];
  for (const site of sites) {
    const workers = workersBySite[site.id]?.size || 0;
    const notesN  = notesBySite[site.id]        || 0;
    const nc      = ncBySite[site.id]           || 0;

    if (workers === 0 && notesN === 0) continue; // nessuna attività

    const siteName = site.name || site.address || 'Cantiere';
    const parts    = [`👷 ${workers} timbrature`];
    if (notesN > 0) parts.push(`📝 ${notesN} note`);
    if (nc > 0)     parts.push(`⚠️ ${nc} NC`);
    lines.push(`📍 <b>${siteName}</b>\n   ${parts.join(' · ')}`);
  }

  if (!lines.length) return; // nessuna attività su nessun cantiere

  const dayName = yesterday.toLocaleDateString('it-IT', {
    timeZone: 'Europe/Rome',
    weekday: 'long', day: 'numeric', month: 'long',
  });

  const text =
    `☀️ <b>Buongiorno! Riepilogo di ${dayName}</b>\n\n` +
    lines.join('\n\n') +
    `\n\nBuona giornata! 👷‍♂️`;

  await notifyCompany(companyId, text);
  console.log(`[dailySummary] company ${companyId}: riepilogo inviato (${lines.length} cantieri)`);
}

// ── Registra il cron ──────────────────────────────────────────────────────────

function startDailySummaryCron() {
  cron.schedule('30 7 * * *', runDailySummary, {
    timezone: 'Europe/Rome',
  });
  console.log('[cron] daily-summary scheduler attivo — esecuzione ogni giorno alle 07:30 (Europe/Rome)');
}

module.exports = { startDailySummaryCron, runDailySummary };
