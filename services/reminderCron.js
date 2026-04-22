'use strict';
/**
 * services/reminderCron.js
 * Invia promemoria note cantiere via Telegram.
 * Schedule: ogni minuto. Processa al massimo 50 promemoria per tick.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const tg       = require('./telegram');

async function processPendingReminders() {
  try {
    const { data: reminders, error } = await supabase
      .from('site_note_reminders')
      .select('id, chat_id, note_text')
      .lte('send_at', new Date().toISOString())
      .is('sent_at', null)
      .limit(50);

    if (error) { console.error('[reminderCron]', error.message); return; }
    if (!reminders || reminders.length === 0) return;

    for (const r of reminders) {
      try {
        await tg.sendMessage(
          r.chat_id,
          `⏰ <b>Promemoria cantiere</b>\n\n${r.note_text.slice(0, 300)}`,
        );
        await supabase
          .from('site_note_reminders')
          .update({ sent_at: new Date().toISOString() })
          .eq('id', r.id);
      } catch (err) {
        // Non blocca gli altri — Telegram potrebbe aver bloccato il bot
        console.error('[reminderCron] send failed', r.id, err.message);
      }
    }
  } catch (err) {
    console.error('[reminderCron] unexpected', err.message);
  }
}

function startReminderCron() {
  cron.schedule('* * * * *', processPendingReminders, { timezone: 'Europe/Rome' });
  console.log('[reminderCron] avviato — ogni minuto');
}

module.exports = { startReminderCron };
