'use strict';
/**
 * services/telegram.js
 * Thin wrapper intorno a Telegram Bot API (REST, nessun SDK pesante).
 * Usa native fetch (Node 18+).
 */

function botUrl(method) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN non configurato');
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function tgPost(method, body) {
  const res = await fetch(botUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(`Telegram API error [${method}]: ${json.description}`);
    err.telegram_code = json.error_code;
    throw err;
  }
  return json.result;
}

// ── Messaggi ────────────────────────────────────────────────

/**
 * Invia un messaggio testo. parseMode default 'HTML'.
 * replyMarkup: optional InlineKeyboardMarkup o ReplyKeyboardMarkup
 */
async function sendMessage(chatId, text, { parseMode = 'HTML', replyMarkup } = {}) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tgPost('sendMessage', body);
}

/**
 * Risponde a un callback_query (tap su inline keyboard).
 * text: testo mostrato come toast (max 200 char).
 */
async function answerCallbackQuery(callbackQueryId, text = '') {
  return tgPost('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
  });
}

// ── File e Media ─────────────────────────────────────────────

/**
 * Ritorna { file_id, file_unique_id, file_size, file_path }
 * file_path è relativo, usarlo con downloadFile().
 */
async function getFile(fileId) {
  return tgPost('getFile', { file_id: fileId });
}

/**
 * Scarica un file da Telegram e ritorna un Buffer.
 */
async function downloadFile(filePath) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ── Keyboard helpers ─────────────────────────────────────────

/**
 * Costruisce una InlineKeyboardMarkup a partire da un array di bottoni.
 * buttons: [{text, callbackData}]
 * columns: quante colonne per riga (default 2)
 */
/**
 * Costruisce una InlineKeyboardMarkup.
 * buttons: [{ text, callbackData }] oppure [{ text, url }]
 * columns: quante colonne per riga (default 2)
 */
function buildInlineKeyboard(buttons, columns = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += columns) {
    rows.push(
      buttons.slice(i, i + columns).map(b => {
        if (b.url) return { text: b.text, url: b.url };
        return { text: b.text, callback_data: b.callbackData || 'noop' };
      })
    );
  }
  return { inline_keyboard: rows };
}

/**
 * Costruisce una ReplyKeyboardMarkup persistente (bottoni fissi sotto la tastiera).
 * rows: array di array di stringhe, es. [['📍 Cantieri', '📋 Note'], ['📊 Stato', '❓ Aiuto']]
 */
function buildReplyKeyboard(rows, { persistent = true, resize = true, oneTime = false } = {}) {
  return {
    keyboard: rows.map(row => row.map(text => ({ text }))),
    resize_keyboard: resize,
    is_persistent: persistent,
    one_time_keyboard: oneTime,
  };
}

/**
 * Rimuove la reply keyboard (torna alla tastiera standard).
 */
function removeReplyKeyboard() {
  return { remove_keyboard: true };
}

// ── Webhook ──────────────────────────────────────────────────

/**
 * Registra il webhook su Telegram.
 * url: URL pubblico del backend, es. https://palladia-backend-production.up.railway.app/api/telegram/webhook
 * secretToken: stringa casuale per verificare che le richieste vengano da Telegram
 */
async function setWebhook(url, secretToken) {
  return tgPost('setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
}

async function deleteWebhook() {
  return tgPost('deleteWebhook', { drop_pending_updates: true });
}

async function getWebhookInfo() {
  return tgPost('getWebhookInfo', {});
}

/**
 * Invia un'azione "typing…" o simile nella chat.
 * action: 'typing' | 'upload_photo' | 'upload_document' | ...
 */
async function sendChatAction(chatId, action = 'typing') {
  return tgPost('sendChatAction', { chat_id: chatId, action });
}

/**
 * Modifica un messaggio già inviato (usato per aggiornare i pannelli owner).
 */
async function editMessageText(chatId, messageId, text, { parseMode = 'HTML', replyMarkup } = {}) {
  const body = {
    chat_id:    chatId,
    message_id: messageId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    return await tgPost('editMessageText', body);
  } catch (err) {
    // Ignora "message is not modified" — non è un errore reale
    if (err.telegram_code === 400) return null;
    throw err;
  }
}

module.exports = {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  sendChatAction,
  getFile,
  downloadFile,
  buildInlineKeyboard,
  buildReplyKeyboard,
  removeReplyKeyboard,
  setWebhook,
  deleteWebhook,
  getWebhookInfo,
};
