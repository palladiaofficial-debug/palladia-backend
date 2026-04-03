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

/**
 * Recupera i chatId Telegram dei coordinatori collegati a un cantiere specifico.
 * Usa site_coordinator_invites → email → telegram_coordinator_links.
 */
async function getCoordinatorChatIds(siteId, excludeChatId = null) {
  // Trova le email dei coordinatori invitati e attivi su questo cantiere
  const { data: invites } = await supabase
    .from('site_coordinator_invites')
    .select('coordinator_email')
    .eq('site_id', siteId)
    .eq('is_active', true);

  if (!invites?.length) return [];

  const emails = invites.map(i => i.coordinator_email);

  // Trova i chatId Telegram di quei coordinatori
  const { data: links } = await supabase
    .from('telegram_coordinator_links')
    .select('telegram_chat_id')
    .in('email', emails);

  return (links || [])
    .map(l => l.telegram_chat_id)
    .filter(id => id !== excludeChatId);
}

/**
 * Invia un messaggio ai coordinatori Telegram collegati a un cantiere.
 */
async function notifyCoordinators(siteId, text, { excludeChatId = null } = {}) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { sent: 0, failed: 0, skipped: true };

  const chatIds = await getCoordinatorChatIds(siteId, excludeChatId);
  if (!chatIds.length) return { sent: 0, failed: 0 };

  const results = await Promise.allSettled(
    chatIds.map(chatId => tg.sendMessage(chatId, text))
  );
  const failed = results.filter(r => r.status === 'rejected').length;
  return { sent: chatIds.length - failed, failed };
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

  const urgIcon = urgency === 'critica' ? '🚨' : '⚠️';
  const text =
    `${urgIcon} <b>Non Conformità segnalata</b>\n\n` +
    `📍 <b>${siteName}</b>\n` +
    `📝 ${description}` +
    (authorName ? `\n👤 Da: ${authorName}` : '');

  // Notifica impresa + coordinatori del cantiere in parallelo
  const [companyResult] = await Promise.all([
    notifyCompany(companyId, text, { excludeChatId }),
    notifyCoordinators(siteId, text, { excludeChatId }).catch(() => {}),
  ]);

  // Segna cooldown solo per NC 'alta' (non 'critica')
  if (urgency !== 'critica' && companyResult.sent > 0) {
    setNcCooldown(companyId, siteId);
  }

  return companyResult;
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
 * Versione legacy senza bottoni — mantenuta per compatibilità.
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
 * Notifica uscite mancanti con bottone azione (versione attiva — cron 20:00).
 * Consente al tecnico di registrare le uscite con un singolo tap.
 *
 * @param {string} companyId
 * @param {string} siteId      - necessario per il callback di azione
 * @param {string} siteName
 * @param {string[]} workerNames
 * @param {string} date        - YYYY-MM-DD, necessario per il callback
 */
async function notifyMissingExitsWithAction(companyId, siteId, siteName, workerNames, date) {
  if (!workerNames?.length) return { sent: 0, failed: 0 };
  if (!process.env.TELEGRAM_BOT_TOKEN) return { sent: 0, failed: 0, skipped: true };

  const list  = workerNames.slice(0, 10).map(n => `• ${n}`).join('\n');
  const extra = workerNames.length > 10 ? `\n…e altri ${workerNames.length - 10}` : '';
  const count = workerNames.length;

  const text =
    `🔔 <b>Uscite mancanti — ${siteName}</b>\n\n` +
    `${count} lavorator${count > 1 ? 'i' : 'e'} senza uscita registrata:\n${list}${extra}\n\n` +
    `Vuoi che Ladia registri le uscite alle 18:00?`;

  // callback_data max 64 chars:
  // "act:reg_exits:{uuid36}:{date10}" = 4+1+9+1+36+1+10 = 62 ✓
  const keyboard = tg.buildInlineKeyboard([
    { text: `✅ Registra uscite (${count})`,  callbackData: `act:reg_exits:${siteId}:${date}` },
    { text: '❌ Ignora',                        callbackData: `act:skip_exits:${siteId}` },
  ], 2);

  const chatIds = await getLinkedChatIds(companyId, null);
  if (!chatIds.length) return { sent: 0, failed: 0 };

  const results = await Promise.allSettled(
    chatIds.map(chatId => tg.sendMessage(chatId, text, { replyMarkup: keyboard }))
  );

  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed) {
    console.error(`[telegramNotifications] notifyMissingExitsWithAction: ${failed}/${chatIds.length} falliti`);
  }
  return { sent: chatIds.length - failed, failed };
}

/**
 * Messaggio personalizzato a tutta la company (broadcast manuale da owner/admin).
 */
async function sendCustomNotification(companyId, text) {
  return notifyCompany(companyId, text);
}

/**
 * Notifica di conferma per azioni eseguite automaticamente da Ladia (Level 1).
 * Non richiede conferma — informa solo che l'azione è già stata completata.
 * Nessun bottone inline: l'azione è già fatta.
 *
 * @param {string} companyId
 * @param {string} text  - testo HTML con il dettaglio dell'azione eseguita
 */
async function notifyAutoExec(companyId, text) {
  return notifyCompany(companyId, text);
}

module.exports = {
  notifyCompany,
  notifyCoordinators,
  notifyNonConformita,
  notifyIncidente,
  notifyMissingExits,
  notifyMissingExitsWithAction,
  notifyAutoExec,
  sendCustomNotification,
};
