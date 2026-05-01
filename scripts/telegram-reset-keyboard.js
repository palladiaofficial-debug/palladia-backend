#!/usr/bin/env node
/**
 * Rimuove la reply keyboard persistente da tutti gli utenti Telegram collegati.
 * Da eseguire UNA VOLTA dopo il deploy del nuovo bot (modalità pura notifiche).
 *
 * Uso: node scripts/telegram-reset-keyboard.js
 */
require('dotenv').config();
const supabase = require('../lib/supabase');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN non configurato'); process.exit(1); }

async function sendReset(chatId) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:      chatId,
      text:
        `🔄 <b>Palladia aggiornato</b>\n\n` +
        `Il bot ora funziona in modalità <b>avvisi automatici</b>.\n` +
        `Riceverai messaggi solo quando c\'è qualcosa da fare.\n\n` +
        `Apri l\'app per gestire cantieri e lavoratori.`,
      parse_mode:   'HTML',
      reply_markup: { remove_keyboard: true },
      disable_web_page_preview: true,
    }),
  });
  const json = await res.json();
  return json.ok;
}

async function run() {
  const { data: users, error } = await supabase
    .from('telegram_users')
    .select('telegram_chat_id');

  if (error) { console.error('Errore fetch utenti:', error.message); process.exit(1); }
  if (!users?.length) { console.log('Nessun utente Telegram collegato.'); return; }

  console.log(`Invio reset keyboard a ${users.length} utenti...`);

  let ok = 0, fail = 0;
  for (const u of users) {
    try {
      const sent = await sendReset(u.telegram_chat_id);
      if (sent) {
        console.log(`  ✓ ${u.telegram_chat_id}`);
        ok++;
      } else {
        console.log(`  ✗ ${u.telegram_chat_id} — errore API`);
        fail++;
      }
    } catch (e) {
      console.log(`  ✗ ${u.telegram_chat_id} — ${e.message}`);
      fail++;
    }
    // Pausa 50ms tra i messaggi (rate limit Telegram: 30 msg/sec)
    await new Promise(r => setTimeout(r, 50));
  }

  console.log(`\nCompletato: ${ok} OK, ${fail} falliti.`);
}

run().catch(e => { console.error(e.message); process.exit(1); });
