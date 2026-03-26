'use strict';
/**
 * services/telegramLog.js
 * Logging fire-and-forget di ogni evento Telegram (inbound/outbound).
 * Non blocca mai l'operazione chiamante.
 */

const supabase = require('../lib/supabase');

/**
 * @param {object} opts
 * @param {string}  opts.direction       'inbound' | 'outbound'
 * @param {string}  opts.messageType     'text' | 'photo' | 'document' | 'command' | 'callback' | 'system'
 * @param {number}  [opts.chatId]
 * @param {string}  [opts.companyId]
 * @param {string}  [opts.siteId]
 * @param {string}  [opts.contentPreview]  testo troncato a 200 char
 * @param {string}  [opts.mediaPath]       percorso storage se presente
 * @param {string}  [opts.status]          'ok' | 'error' | 'ignored' | 'rate_limited'
 * @param {string}  [opts.errorMsg]
 */
function logEvent(opts) {
  const row = {
    direction:        opts.direction,
    message_type:     opts.messageType  || null,
    telegram_chat_id: opts.chatId       || null,
    company_id:       opts.companyId    || null,
    site_id:          opts.siteId       || null,
    content_preview:  opts.contentPreview ? String(opts.contentPreview).slice(0, 200) : null,
    media_path:       opts.mediaPath    || null,
    status:           opts.status       || 'ok',
    error_msg:        opts.errorMsg     || null,
  };

  supabase.from('telegram_event_logs').insert(row)
    .then(({ error }) => {
      if (error) console.error('[telegramLog] insert error:', error.message);
    });
}

module.exports = { logEvent };
