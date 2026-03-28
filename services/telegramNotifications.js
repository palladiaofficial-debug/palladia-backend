'use strict';
/**
 * services/telegramNotifications.js
 * Notifiche outbound verso gli utenti Telegram collegati.
 *
 * REGOLE ANTI-SPAM:
 * - Le notifiche di NC/Incidente escludono sempre chi ha inviato il messaggio
 * - NC con urgency 'alta': cooldown 30 min per cantiere (evita raffica di notifiche)
 * - NC con urgency 'critica' e Incidenti: sempre immediati, nessun cooldown
 * - Note normali, foto, documenti: mai notificate (silenzioso)
 */

const tg       = require('./telegram');
const supabase = require('../lib/supabase');

// ── Cooldown NC: max 1 notifica per cantiere ogni 30 minuti ──
// In-memory: va bene per server single-instance (Railway)
const NC_COOLDOWN_MS = 30 * 60 * 1000; // 30 minuti
const ncLastNotified = new Map(); // key: `${companyId}:${siteId}` → timestamp

function isNcOnCooldown(companyId, siteId) {
  const key  = `${companyId}:${siteId}`;
  const last = ncLastNotified.get(key);
  return last && (Date.now() - last) < NC_COOLDOWN_MS;
}

function setNcCooldown(companyId, siteId) {
  ncLastNotified.set(`${companyId}:${siteId}`, Date.now());
}

// ── Helper: recupera chat IDs (esclude opzionalmente il mittente) ──

async function getLinkedChatIds(companyId, excludeChatId = null) {
  const { data, error } = await supabase
    .from('telegram_users')
    .select('telegram_chat_id')
    .eq('company_id', companyId);

  if (error) {
    console.error('[telegramNotifications] getLinkedChatIds error:', error.message);
    return [];
  }

  return (data || [])
    .map(u => u.telegram_chat_id)
    .filter(id => id !== excludeChatId);
}

// ── Broadcast base ────────────────────────────────────────────

/**
 * Invia un messaggio a tutti gli utenti collegati della company.
 * excludeChatId: ometti il mittente originale (non notificare chi ha già inviato)
 */
async function notifyCompany(companyId, text, { excludeChatId = null } = {}) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { sent: 0, failed: 0, skipped: true };

  const chatIds = await getLinkedChatIds(companyId, excludeChatId);
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
 * Notifica una Non Conformità.
 * urgency 'critica' → sempre immediata
 * urgency 'alta'    → cooldown 30 min per cantiere (anti-spam)
 * urgency 'normale' → silenzioso, non notifica
 *
 * siteId è usato solo per il cooldown; siteName per il testo.
 */
async function notifyNonConformita(companyId, siteId, siteName, description, authorName, urgency, excludeChatId) {
  // Note normali: silenzio totale
  if (urgency === 'normale') return { sent: 0, skipped: true };

  // NC alta: rispetta il cooldown (anti-spam)
  if (urgency !== 'critica' && isNcOnCooldown(companyId, siteId)) {
    console.log(`[telegramNotifications] NC cooldown attivo per ${companyId}:${siteId} — skip`);
    return { sent: 0, skipped: true };
  }

  const text =
    `⚠️ <b>Non Conformità segnalata</b>\n\n` +
    `📍 <b>${siteName}</b>\n` +
    `📝 ${description}` +
    (authorName ? `\n👤 Segnalata da: ${authorName}` : '');

  const result = await notifyCompany(companyId, text, { excludeChatId });

  // Segna cooldown solo per NC 'alta' (non 'critica')
  if (urgency !== 'critica' && result.sent > 0) {
    setNcCooldown(companyId, siteId);
  }

  return result;
}

/**
 * Notifica un incidente — sempre immediato, nessun cooldown.
 */
async function notifyIncidente(companyId, siteName, description, authorName, excludeChatId) {
  const text =
    `🚨 <b>INCIDENTE segnalato</b>\n\n` +
    `📍 <b>${siteName}</b>\n` +
    `📝 ${description}` +
    (authorName ? `\n👤 Da: ${authorName}` : '');
  return notifyCompany(companyId, text, { excludeChatId });
}

/**
 * Notifica uscite mancanti a fine giornata (cron 20:00).
 * Inviata a tutti senza esclusioni (è un alert gestionale, non un evento real-time).
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
 * Messaggio personalizzato a tutta la company (broadcast manuale da owner/admin).
 */
async function sendCustomNotification(companyId, text) {
  return notifyCompany(companyId, text);
}

module.exports = {
  notifyCompany,
  notifyNonConformita,
  notifyIncidente,
  notifyMissingExits,
  sendCustomNotification,
};
