'use strict';
/**
 * services/telegramNotifications.js
 * Notifiche outbound: la piattaforma invia messaggi proattivi via Telegram
 * agli utenti di una company che hanno collegato il bot.
 *
 * Uso tipico:
 *   const { notifyNonConformita } = require('./telegramNotifications');
 *   await notifyNonConformita(companyId, siteName, description, authorName);
 */

const tg       = require('./telegram');
const supabase = require('../lib/supabase');

// ── Helper: recupera chat IDs di tutti gli utenti collegati ──

async function getLinkedChatIds(companyId) {
  const { data, error } = await supabase
    .from('telegram_users')
    .select('telegram_chat_id')
    .eq('company_id', companyId);

  if (error) {
    console.error('[telegramNotifications] getLinkedChatIds error:', error.message);
    return [];
  }
  return (data || []).map(u => u.telegram_chat_id);
}

// ── Broadcast a tutti gli utenti collegati di una company ────

async function notifyCompany(companyId, text) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { sent: 0, failed: 0, skipped: true };

  const chatIds = await getLinkedChatIds(companyId);
  if (!chatIds.length) return { sent: 0, failed: 0 };

  const results = await Promise.allSettled(
    chatIds.map(chatId => tg.sendMessage(chatId, text))
  );

  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed) {
    console.error(`[telegramNotifications] ${failed}/${chatIds.length} messaggi falliti per company ${companyId}`);
  }
  return { sent: chatIds.length - failed, failed };
}

// ── Notifiche specifiche ──────────────────────────────────────

/**
 * Notifica una Non Conformità appena segnalata (da web o da qualsiasi fonte).
 */
async function notifyNonConformita(companyId, siteName, description, authorName) {
  const text =
    `⚠️ <b>Non Conformità segnalata</b>\n\n` +
    `📍 <b>${siteName}</b>\n` +
    `📝 ${description}` +
    (authorName ? `\n👤 Segnalata da: ${authorName}` : '');
  return notifyCompany(companyId, text);
}

/**
 * Notifica un incidente.
 */
async function notifyIncidente(companyId, siteName, description, authorName) {
  const text =
    `🚨 <b>INCIDENTE segnalato</b>\n\n` +
    `📍 <b>${siteName}</b>\n` +
    `📝 ${description}` +
    (authorName ? `\n👤 Da: ${authorName}` : '');
  return notifyCompany(companyId, text);
}

/**
 * Notifica lavoratori con uscita mancante a fine giornata.
 */
async function notifyMissingExits(companyId, siteName, workerNames) {
  if (!workerNames || !workerNames.length) return { sent: 0, failed: 0 };
  const list  = workerNames.slice(0, 10).map(n => `• ${n}`).join('\n');
  const extra = workerNames.length > 10 ? `\n…e altri ${workerNames.length - 10}` : '';
  const text =
    `🔔 <b>Uscite mancanti — ${siteName}</b>\n\n` +
    `I seguenti lavoratori non hanno registrato l'uscita:\n${list}${extra}\n\n` +
    `Verifica su <b>palladia.net</b>`;
  return notifyCompany(companyId, text);
}

/**
 * Riepilogo mattutino di un cantiere.
 */
async function sendDailySummary(companyId, siteName, stats) {
  const { workersExpected = 0, notesYesterday = 0, openNc = 0 } = stats || {};
  const text =
    `☀️ <b>Buongiorno — ${siteName}</b>\n\n` +
    `📊 Riepilogo di ieri:\n` +
    `👷 Lavoratori registrati: <b>${workersExpected}</b>\n` +
    `📝 Note archiviate: <b>${notesYesterday}</b>\n` +
    (openNc > 0 ? `⚠️ Non conformità aperte: <b>${openNc}</b>\n` : '') +
    `\nHai una buona giornata di lavoro! 👷‍♂️`;
  return notifyCompany(companyId, text);
}

/**
 * Messaggio generico a tutta la company.
 */
async function sendCustomNotification(companyId, text) {
  return notifyCompany(companyId, text);
}

module.exports = {
  notifyCompany,
  notifyNonConformita,
  notifyIncidente,
  notifyMissingExits,
  sendDailySummary,
  sendCustomNotification,
};
