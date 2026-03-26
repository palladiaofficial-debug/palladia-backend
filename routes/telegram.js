'use strict';
/**
 * routes/telegram.js
 * Webhook pubblico ricevuto da Telegram.
 * Sicurezza: X-Telegram-Bot-Api-Secret-Token header.
 * Rate limit: 30 messaggi/min per telegram_chat_id (in-memory).
 *
 * POST /api/telegram/webhook
 */

const router         = require('express').Router();
const { handleUpdate } = require('../services/telegramHandler');
const { logEvent }   = require('../services/telegramLog');
const tg             = require('../services/telegram');

// ── Rate limit per chat_id ────────────────────────────────────
// In-memory: sufficiente per V1. In caso di scale-out usare Redis.
const chatRateMap  = new Map(); // chatId → { count, windowStart }
const RATE_MAX     = 30;           // messaggi max
const RATE_WINDOW  = 60 * 1000;    // per finestra di 1 minuto

function checkChatRateLimit(chatId) {
  const now   = Date.now();
  const entry = chatRateMap.get(chatId);
  if (!entry || now - entry.windowStart > RATE_WINDOW) {
    chatRateMap.set(chatId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_MAX) return false;
  entry.count++;
  return true;
}

// Pulizia periodica della map (ogni 5 min) — evita memory leak
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW;
  for (const [key, val] of chatRateMap.entries()) {
    if (val.windowStart < cutoff) chatRateMap.delete(key);
  }
}, 5 * 60 * 1000);

// ── Webhook ──────────────────────────────────────────────────

router.post('/webhook', async (req, res) => {
  // 1. Verifica secret token Telegram
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const header = req.headers['x-telegram-bot-api-secret-token'];
  if (secret && header !== secret) {
    console.warn('[telegram-webhook] secret token non valido');
    return res.sendStatus(403);
  }

  // 2. Rispondi subito a Telegram (Telegram ritenta dopo 5s di silenzio)
  res.sendStatus(200);

  const update = req.body;
  if (!update) return;

  // 3. Estrai chat_id per rate limit e logging
  const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;

  // 4. Rate limit per chat_id
  if (chatId && !checkChatRateLimit(chatId)) {
    console.warn(`[telegram-webhook] rate limit superato — chat_id ${chatId}`);
    logEvent({
      direction:    'inbound',
      messageType:  'system',
      chatId,
      status:       'rate_limited',
      contentPreview: 'Rate limit superato',
    });
    // Avvisa l'utente (una volta) — non blocca il processo
    tg.sendMessage(chatId,
      '⚠️ Stai inviando troppi messaggi. Attendi un minuto e riprova.'
    ).catch(() => {});
    return;
  }

  // 5. Determina tipo messaggio per logging
  let messageType = 'text';
  if (update.callback_query)         messageType = 'callback';
  else if (update.message?.photo)    messageType = 'photo';
  else if (update.message?.document) messageType = 'document';
  else if (update.message?.voice)    messageType = 'voice';
  else if (update.message?.text?.startsWith('/')) messageType = 'command';

  // 6. Log evento inbound
  logEvent({
    direction:      'inbound',
    messageType,
    chatId,
    contentPreview: update.message?.text || update.callback_query?.data || null,
    status:         'ok',
  });

  // 7. Gestisci in background
  handleUpdate(update).catch(err => {
    console.error('[telegram-webhook] handleUpdate error:', err.message);
    logEvent({
      direction:    'inbound',
      messageType:  'system',
      chatId,
      status:       'error',
      errorMsg:     err.message,
    });
  });
});

module.exports = router;
