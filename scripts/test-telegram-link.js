'use strict';
/**
 * Test end-to-end del collegamento Telegram.
 * Simula: genera token → invia /start TOKEN al webhook → verifica telegram_users.
 *
 * Uso: node scripts/test-telegram-link.js
 */

require('dotenv').config();
const https  = require('https');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const WEBHOOK_URL    = `${process.env.APP_BASE_URL}/api/telegram/webhook`;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

// Utente e company di test — prende il primo owner disponibile
async function getTestUser() {
  const { data } = await supabase
    .from('company_users')
    .select('user_id, company_id, role')
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle();
  return data;
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port:     u.port || 443,
      path:     u.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('── Test collegamento Telegram ─────────────────────────');

  // 1. Trova utente owner
  const user = await getTestUser();
  if (!user) { console.error('✗ Nessun owner trovato in company_users'); process.exit(1); }
  console.log(`✓ Utente test: user_id=${user.user_id.slice(0, 8)}… company_id=${user.company_id.slice(0, 8)}…`);

  // 2. Inserisce token di collegamento direttamente in Supabase
  const token     = crypto.randomBytes(12).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + 60 * 1000).toISOString(); // 1 min
  const { error: insErr } = await supabase.from('telegram_link_tokens').insert({
    token, company_id: user.company_id, user_id: user.user_id, expires_at: expiresAt,
  });
  if (insErr) { console.error('✗ Insert token fallito:', insErr.message); process.exit(1); }
  console.log(`✓ Token creato: ${token}`);

  // 3. Simula /start TOKEN via webhook
  const fakeChatId = 9999999999; // ID fittizio non esistente in produzione
  const update = {
    update_id: 999999999,
    message: {
      message_id: 1,
      from: { id: fakeChatId, first_name: 'TestBot', username: 'test_palladia' },
      chat: { id: fakeChatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text: `/start ${token}`,
    },
  };

  console.log(`✓ POST webhook → ${WEBHOOK_URL}`);
  let webhookRes;
  try {
    webhookRes = await postJson(WEBHOOK_URL, update, {
      'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
    });
  } catch (e) {
    console.error('✗ Chiamata webhook fallita:', e.message);
    process.exit(1);
  }
  console.log(`  HTTP ${webhookRes.status} (atteso 200)`);
  if (webhookRes.status !== 200) { console.error('✗ Webhook ha risposto con errore'); process.exit(1); }

  // 4. Aspetta 1s che handleUpdate completi (è asincrono)
  await new Promise(r => setTimeout(r, 1500));

  // 5. Verifica che telegram_users sia stato creato
  const { data: tgUser } = await supabase
    .from('telegram_users')
    .select('user_id, company_id, telegram_chat_id, telegram_username, telegram_first_name, linked_at')
    .eq('telegram_chat_id', fakeChatId)
    .maybeSingle();

  if (!tgUser) {
    console.error('✗ telegram_users non aggiornato — il collegamento non ha funzionato');
    process.exit(1);
  }
  console.log('✓ telegram_users creato:');
  console.log(`    chat_id=${tgUser.telegram_chat_id}, first_name="${tgUser.telegram_first_name}", username="${tgUser.telegram_username}"`);

  // 6. Verifica che il token sia stato consumato (eliminato)
  const { data: tokenRow } = await supabase
    .from('telegram_link_tokens')
    .select('token')
    .eq('token', token)
    .maybeSingle();
  if (tokenRow) {
    console.warn('⚠ Token non eliminato dopo il collegamento');
  } else {
    console.log('✓ Token eliminato (monouso)');
  }

  // 7. Cleanup
  await supabase.from('telegram_users').delete().eq('telegram_chat_id', fakeChatId);
  console.log('✓ Cleanup dati di test completato');
  console.log('── PASS ─────────────────────────────────────────────────');
}

run().catch(e => { console.error('Errore imprevisto:', e); process.exit(1); });
