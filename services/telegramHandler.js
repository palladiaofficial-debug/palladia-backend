'use strict';
/**
 * services/telegramHandler.js
 * Bot Telegram — modalità pura notifiche.
 *
 * Riceve aggiornamenti solo per collegare l'account (/start TOKEN).
 * Qualsiasi altro messaggio riceve un redirect all'app.
 * Tutta la logica interattiva (cantieri, note, Ladia, pulsanti) è rimossa:
 * Telegram è esclusivamente il canale di alerting di Palladia.
 */

const tg       = require('./telegram');
const supabase = require('../lib/supabase');

const FRONTEND_URL = (process.env.FRONTEND_URL || process.env.APP_BASE_URL || 'https://palladia.net').replace(/\/$/, '');

async function handleUpdate(update) {
  try {
    const msg = update.message || update.edited_message;
    if (msg) return await handleMessage(msg);
    // callback_query ignorati — non ci sono più bottoni nelle notifiche
  } catch (e) {
    console.error('[telegramHandler] errore:', e.message);
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();

  if (text.startsWith('/start')) {
    const token = text.split(' ')[1]?.trim();
    return linkAccount(chatId, token, msg.from);
  }

  // Qualsiasi altro messaggio → redirect all'app + rimuove la tastiera
  return tg.sendMessage(chatId,
    `📲 <b>Palladia — Gestione Cantieri</b>\n\n` +
    `Questo canale invia avvisi automatici sulla tua impresa.\n\n` +
    `Per gestire cantieri, lavoratori e documenti apri l\'app:\n` +
    `<a href="${FRONTEND_URL}">${FRONTEND_URL}</a>`,
    { replyMarkup: tg.removeReplyKeyboard() }
  );
}

async function linkAccount(chatId, token, from) {
  if (!token) {
    return tg.sendMessage(chatId,
      `👋 Benvenuto su <b>Palladia</b>.\n\n` +
      `Per collegare il tuo account apri l\'app e vai in\n<b>Impostazioni → Collega Telegram</b>.`
    );
  }

  const { data: linkToken } = await supabase
    .from('telegram_link_tokens')
    .select('user_id, company_id, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (!linkToken || new Date(linkToken.expires_at) < new Date()) {
    return tg.sendMessage(chatId,
      `❌ Link non valido o scaduto.\nGenera un nuovo link dall\'app Palladia.`
    );
  }

  const { error } = await supabase
    .from('telegram_users')
    .upsert({
      user_id:              linkToken.user_id,
      company_id:           linkToken.company_id,
      telegram_chat_id:     chatId,
      telegram_username:    from?.username   || null,
      telegram_first_name:  from?.first_name || null,
      linked_at:            new Date().toISOString(),
    }, { onConflict: 'telegram_chat_id' });

  await supabase.from('telegram_link_tokens').delete().eq('token', token);

  if (error) {
    return tg.sendMessage(chatId, `❌ Errore durante il collegamento. Riprova dall\'app.`);
  }

  return tg.sendMessage(chatId,
    `✅ <b>Account collegato!</b>\n\n` +
    `Riceverai qui avvisi automatici su:\n` +
    `• Documenti obbligatori mancanti\n` +
    `• Documenti in scadenza (lavoratori, mezzi, aziendali)\n` +
    `• Uscite non registrate a fine giornata\n` +
    `• Non conformità urgenti\n\n` +
    `Nessuna azione richiesta — gli avvisi arrivano automaticamente.`,
    { replyMarkup: tg.removeReplyKeyboard() }
  );
}

module.exports = { handleUpdate };
