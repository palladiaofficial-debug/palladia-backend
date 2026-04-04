'use strict';
/**
 * services/weeklyValueCron.js
 *
 * Report settimanale del valore — ogni lunedì alle 07:45 (Europe/Rome).
 * Mostra al tecnico cosa ha fatto Ladia la settimana scorsa, in numeri.
 *
 * Scopo: rendere visibile il risparmio di tempo → giustificazione dell'abbonamento.
 * Se non ci sono dati rilevanti (azienda inattiva) → nessun messaggio.
 *
 * Struttura:
 *   - Presenze monitorate
 *   - Azioni eseguite da Ladia (da ladia_action_log)
 *   - Alert proattivi inviati (da ladia_proactive_log)
 *   - Stima ore risparmiate
 *   - Confronto con settimana precedente (se dati disponibili)
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const tg       = require('./telegram');

// Minuti risparmiati per tipo di azione
const TIME_SAVED_MIN = {
  reg_exits:      3,   // registrazione uscite automatica
  close_nc:       5,   // chiusura NC
  rain_notify:    5,   // allerta meteo inviata
  heat_notify:    5,   // allerta caldo inviata
  expiry_remind:  3,   // promemoria scadenza
};
const TIME_SAVED_ALERT_MIN = 2; // alert proattivo inviato = problema prevenuto

// ── Costruisce il report per una company ──────────────────────

async function buildWeeklyReport(companyId) {
  const now     = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 86_400_000);

  const weekStart  = weekAgo.toISOString();
  const weekEnd    = now.toISOString();
  const prevStart  = twoWeeksAgo.toISOString();
  const prevEnd    = weekAgo.toISOString();

  const [actRes, actPrevRes, presRes, siteRes, alertRes] = await Promise.all([
    // Azioni eseguite questa settimana
    supabase.from('ladia_action_log')
      .select('action_type, action_params, site_id')
      .eq('company_id', companyId)
      .eq('result', 'ok')
      .gte('executed_at', weekStart)
      .lte('executed_at', weekEnd)
      .limit(500),

    // Azioni settimana precedente (confronto)
    supabase.from('ladia_action_log')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('result', 'ok')
      .gte('executed_at', prevStart)
      .lte('executed_at', prevEnd),

    // Presenze registrate questa settimana
    supabase.from('presence_logs')
      .select('worker_id, site_id')
      .eq('company_id', companyId)
      .eq('event_type', 'ENTRY')
      .gte('timestamp_server', weekStart)
      .lte('timestamp_server', weekEnd)
      .limit(5000),

    // Cantieri attivi
    supabase.from('sites')
      .select('id, name, address')
      .eq('company_id', companyId)
      .neq('status', 'chiuso')
      .limit(30),

    // Alert proattivi inviati questa settimana
    supabase.from('ladia_proactive_log')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('sent_at', weekStart)
      .lte('sent_at', weekEnd),
  ]);

  const actions    = actRes.data   || [];
  const presences  = presRes.data  || [];
  const sites      = siteRes.data  || [];
  const prevCount  = actPrevRes.count || 0;
  const alertCount = alertRes.count  || 0;

  // Niente da mostrare se nessuna attività
  if (!actions.length && !presences.length && !alertCount) return null;

  const siteMap = new Map(sites.map(s => [s.id, s.name || s.address || 'Cantiere']));

  // ── Calcola metriche ──
  const actionCounts = {};
  let timeSavedMin   = 0;

  for (const a of actions) {
    actionCounts[a.action_type] = (actionCounts[a.action_type] || 0) + 1;
    timeSavedMin += TIME_SAVED_MIN[a.action_type] || 0;
  }
  timeSavedMin += alertCount * TIME_SAVED_ALERT_MIN;

  const uniqueWorkers = new Set(presences.map(p => p.worker_id)).size;
  const activeSites   = new Set(presences.map(p => p.site_id)).size;

  // ── Confronto settimana precedente ──
  const diffLabel = (() => {
    if (!prevCount || !actions.length) return null;
    const diff = actions.length - prevCount;
    if (diff > 0) return `+${diff} rispetto alla settimana scorsa`;
    if (diff < 0) return `${diff} rispetto alla settimana scorsa`;
    return null;
  })();

  // ── Label date ──
  const fmtDate = (d) => d.toLocaleDateString('it-IT', {
    timeZone: 'Europe/Rome', day: 'numeric', month: 'long',
  });
  const dateRange = `${fmtDate(weekAgo)} – ${fmtDate(now)}`;

  // ── Componi messaggio ──
  const timeSavedLabel = timeSavedMin >= 60
    ? `~${Math.round(timeSavedMin / 60 * 2) / 2}h`
    : `~${Math.ceil(timeSavedMin / 5) * 5} minuti`;

  let msg = `📊 <b>Ladia — Settimana ${dateRange}</b>\n`;

  if (activeSites > 0) {
    msg += `\n👷 <b>${uniqueWorkers} presenze</b> monitorate su ${activeSites} cantier${activeSites > 1 ? 'i' : 'e'}`;
  }

  const actionLines = [];
  if (actionCounts.reg_exits)      actionLines.push(`• ${actionCounts.reg_exits} uscit${actionCounts.reg_exits > 1 ? 'e registrate' : 'a registrata'} automaticamente`);
  if (actionCounts.close_nc)       actionLines.push(`• ${actionCounts.close_nc} NC chiusa${actionCounts.close_nc > 1 ? '' : ''}`);
  if (actionCounts.rain_notify)    actionLines.push(`• ${actionCounts.rain_notify} allert${actionCounts.rain_notify > 1 ? 'e' : 'a'} meteo inviata${actionCounts.rain_notify > 1 ? '' : ''}`);
  if (actionCounts.heat_notify)    actionLines.push(`• ${actionCounts.heat_notify} allert${actionCounts.heat_notify > 1 ? 'e' : 'a'} caldo inviata${actionCounts.heat_notify > 1 ? '' : ''}`);
  if (actionCounts.expiry_remind)  actionLines.push(`• ${actionCounts.expiry_remind} promemori${actionCounts.expiry_remind > 1 ? 'a' : 'o'} scadenza inviato`);
  if (alertCount > 0)              actionLines.push(`• ${alertCount} alert proattiv${alertCount > 1 ? 'i' : 'o'} inviato`);

  if (actionLines.length) {
    msg += `\n\n🤖 <b>Fatto da Ladia:</b>\n${actionLines.join('\n')}`;
    if (diffLabel) msg += `\n<i>${diffLabel}</i>`;
  }

  msg += `\n\n⏱️ <b>Stima tempo risparmiato: ${timeSavedLabel}</b>`;

  msg += `\n\n<i>Scrivi /impostazioni per gestire le notifiche.</i>`;

  return msg;
}

// ── Job principale ────────────────────────────────────────────

async function runWeeklyReport() {
  console.log('[weeklyReport] avvio report settimanale');

  const { data: tuUsers, error } = await supabase
    .from('telegram_users')
    .select('company_id, telegram_chat_id')
    .limit(1000);

  if (error) {
    console.error('[weeklyReport] errore fetch telegram_users:', error.message);
    return;
  }

  // Un report per company, inviato a tutti gli utenti collegati
  const companyMap = new Map();
  for (const u of (tuUsers || [])) {
    if (!companyMap.has(u.company_id)) companyMap.set(u.company_id, []);
    companyMap.get(u.company_id).push(u.telegram_chat_id);
  }

  let sent = 0;
  for (const [companyId, chatIds] of companyMap) {
    try {
      const msg = await buildWeeklyReport(companyId);
      if (!msg) continue;

      await Promise.allSettled(chatIds.map(chatId => tg.sendMessage(chatId, msg)));
      sent++;
    } catch (e) {
      console.error(`[weeklyReport] errore company ${companyId}:`, e.message);
    }
  }

  console.log(`[weeklyReport] completato — ${sent} company notificate`);
}

// ── Registra il cron ──────────────────────────────────────────

function startWeeklyValueCron() {
  // Ogni lunedì alle 07:45 — arriva prima del briefing mattutino (07:55 tipicamente)
  cron.schedule('45 7 * * 1', runWeeklyReport, { timezone: 'Europe/Rome' });
  console.log('[cron] weekly-value-report attivo — ogni lunedì 07:45 Europe/Rome');
}

module.exports = { startWeeklyValueCron, runWeeklyReport };
