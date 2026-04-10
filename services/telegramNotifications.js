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
 * Ritorna tutti gli utenti Telegram di una company con i loro cantieri consentiti.
 * - owner/admin → allowedSiteIds = null  (= tutti i cantieri)
 * - tech/viewer → allowedSiteIds = [...] (solo i cantieri assegnati via user_site_assignments)
 *
 * @returns {Promise<Array<{chatId: bigint, userId: string, allowedSiteIds: string[]|null}>>}
 */
async function getCompanyTelegramUsers(companyId) {
  const [tuRes, cuRes] = await Promise.all([
    supabase.from('telegram_users')
      .select('telegram_chat_id, user_id, notification_level')
      .eq('company_id', companyId),
    supabase.from('company_users')
      .select('user_id, role')
      .eq('company_id', companyId),
  ]);

  const tuUsers = tuRes.data || [];
  if (!tuUsers.length) return [];

  const roleMap = new Map((cuRes.data || []).map(c => [c.user_id, c.role]));

  // Utenti che richiedono filtro per cantiere
  const techUserIds = tuUsers
    .filter(u => { const r = roleMap.get(u.user_id); return r === 'tech' || r === 'viewer'; })
    .map(u => u.user_id);

  // Fetch assegnazioni solo per tech/viewer (batch unico)
  const assignmentsByUser = new Map();
  if (techUserIds.length) {
    const { data: assignments, error: assignErr } = await supabase
      .from('user_site_assignments')
      .select('user_id, site_id')
      .eq('company_id', companyId)
      .in('user_id', techUserIds);

    if (assignErr) {
      // Tabella non ancora migrata — fallback: tutti vedono tutti i cantieri (comportamento pre-036)
      console.warn('[getCompanyTelegramUsers] user_site_assignments non disponibile — fallback all-sites:', assignErr.message);
      return tuUsers.map(u => ({ chatId: u.telegram_chat_id, userId: u.user_id, allowedSiteIds: null }));
    }

    for (const a of assignments || []) {
      if (!assignmentsByUser.has(a.user_id)) assignmentsByUser.set(a.user_id, []);
      assignmentsByUser.get(a.user_id).push(a.site_id);
    }
  }

  return tuUsers.map(u => {
    const role    = roleMap.get(u.user_id) || 'tech';
    const isAdmin = role === 'owner' || role === 'admin';
    return {
      chatId:            u.telegram_chat_id,
      userId:            u.user_id,
      notificationLevel: u.notification_level || 'balanced',
      allowedSiteIds:    isAdmin ? null : (assignmentsByUser.get(u.user_id) || []),
    };
  });
}

/**
 * Ritorna i chat ID degli utenti abilitati a ricevere notifiche per un cantiere specifico.
 * owner/admin → sempre inclusi
 * tech/viewer → solo se hanno quel siteId nelle loro assegnazioni
 */
async function getLinkedChatIdsForSite(companyId, siteId, excludeChatId = null) {
  const users = await getCompanyTelegramUsers(companyId);
  return users
    .filter(u => u.allowedSiteIds === null || u.allowedSiteIds.includes(siteId))
    .map(u => u.chatId)
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
    `${urgIcon} <b>Non Conformità — ${siteName}</b>\n\n` +
    `${description}` +
    (authorName ? `\nDa: ${authorName}` : '');

  // Notifica solo utenti assegnati a questo cantiere + coordinatori
  const [companyResult] = await Promise.all([
    notifySiteTeam(companyId, siteId, text, { excludeChatId }),
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
async function notifyIncidente(companyId, siteId, siteName, description, authorName, excludeChatId) {
  const text =
    `🚨 <b>INCIDENTE — ${siteName}</b>\n\n` +
    `${description}` +
    (authorName ? `\nDa: ${authorName}` : '');
  return notifySiteTeam(companyId, siteId, text, { excludeChatId });
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
 * Invia un testo agli utenti abilitati a ricevere notifiche per un cantiere specifico.
 * Sostituisce notifyCompany() per tutti gli alert puntuali (NC, incidente, uscite).
 */
async function notifySiteTeam(companyId, siteId, text, { excludeChatId = null } = {}) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return { sent: 0, failed: 0, skipped: true };

  const chatIds = await getLinkedChatIdsForSite(companyId, siteId, excludeChatId);
  if (!chatIds.length) return { sent: 0, failed: 0 };

  const results = await Promise.allSettled(chatIds.map(chatId => tg.sendMessage(chatId, text)));
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed) {
    console.error(`[telegramNotifications] notifySiteTeam: ${failed}/${chatIds.length} falliti (site ${siteId})`);
  }
  return { sent: chatIds.length - failed, failed };
}

/**
 * Notifica timbratura (ENTRY/EXIT) — inviata fire-and-forget da scan.js dopo punch_atomic.
 *
 * Livelli:
 *  quiet    → nessuna notifica timbratura
 *  balanced → solo ENTRY (default se non impostato)
 *  full     → ENTRY + EXIT
 *
 * @param {string} companyId
 * @param {string} siteId
 * @param {string} siteName
 * @param {string} workerName
 * @param {'ENTRY'|'EXIT'} eventType
 * @param {string} timestampServer  - ISO string
 */
async function notifyPunch(companyId, siteId, siteName, workerName, eventType, timestampServer) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;

  let users;
  try {
    users = await getCompanyTelegramUsers(companyId);
  } catch (e) {
    console.error('[notifyPunch] getCompanyTelegramUsers error:', e.message);
    return;
  }

  if (!users.length) return;

  // Orario locale (Europe/Rome) — solo HH:MM
  let timeStr;
  try {
    timeStr = new Date(timestampServer).toLocaleTimeString('it-IT', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome'
    });
  } catch {
    timeStr = timestampServer ? timestampServer.slice(11, 16) : '';
  }

  const isEntry = eventType === 'ENTRY';
  const icon    = isEntry ? '👷' : '🚪';
  const label   = isEntry ? 'entrata' : 'uscita';
  const text    = `${icon} <b>${workerName}</b> — ${label}\n📍 ${siteName} · ${timeStr}`;

  const sends = [];
  for (const u of users) {
    // Filtra per cantiere assegnato
    if (u.allowedSiteIds !== null && !u.allowedSiteIds.includes(siteId)) continue;

    const level = u.notificationLevel || 'balanced';
    if (level === 'quiet') continue;
    if (level === 'balanced' && !isEntry) continue; // balanced → solo ENTRY

    sends.push(tg.sendMessage(u.chatId, text).catch(e => {
      console.error('[notifyPunch] sendMessage error:', e.message);
    }));
  }

  if (sends.length) await Promise.allSettled(sends);
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
  notifyPunch,
  notifySiteTeam,
  sendCustomNotification,
  getCompanyTelegramUsers,
  getLinkedChatIdsForSite,
};
