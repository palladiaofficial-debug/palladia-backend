#!/usr/bin/env node
/**
 * scripts/setup-telegram-webhook.js
 *
 * Registra il webhook Telegram e verifica la configurazione.
 * Da eseguire UNA VOLTA dopo aver configurato le variabili d'ambiente.
 *
 * Uso:
 *   node scripts/setup-telegram-webhook.js
 *   node scripts/setup-telegram-webhook.js --delete   (rimuove il webhook)
 *   node scripts/setup-telegram-webhook.js --info     (mostra stato webhook)
 */

require('dotenv').config();

const { setWebhook, deleteWebhook, getWebhookInfo } = require('../services/telegram');

async function main() {
  const args = process.argv.slice(2);

  const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
  const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
  const APP_BASE_URL   = process.env.APP_BASE_URL;

  // ── Validazione env ──────────────────────────────────────────
  if (!BOT_TOKEN) {
    console.error('❌  TELEGRAM_BOT_TOKEN non configurato');
    console.log('\nConfigura su Railway le seguenti variabili d\'ambiente:');
    console.log('  TELEGRAM_BOT_TOKEN     — dal BotFather (es. 1234567890:ABC...)');
    console.log('  TELEGRAM_WEBHOOK_SECRET — stringa casuale (es. openssl rand -hex 32)');
    console.log('  TELEGRAM_BOT_USERNAME  — username del bot senza @ (es. PalladiaBot)');
    process.exit(1);
  }

  // ── --info ───────────────────────────────────────────────────
  if (args.includes('--info')) {
    console.log('ℹ️  Stato webhook Telegram...\n');
    const info = await getWebhookInfo();
    console.log('Webhook URL:       ', info.url || '(nessuno)');
    console.log('Pending updates:   ', info.pending_update_count || 0);
    console.log('Last error:        ', info.last_error_message   || 'nessuno');
    console.log('Last error date:   ', info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : '-');
    return;
  }

  // ── --delete ─────────────────────────────────────────────────
  if (args.includes('--delete')) {
    console.log('🗑️  Rimozione webhook Telegram...');
    await deleteWebhook();
    console.log('✅  Webhook rimosso.');
    return;
  }

  // ── Setup ────────────────────────────────────────────────────
  if (!APP_BASE_URL) {
    console.error('❌  APP_BASE_URL non configurato (es. https://palladia-backend-production.up.railway.app)');
    process.exit(1);
  }

  if (!WEBHOOK_SECRET) {
    console.warn('⚠️  TELEGRAM_WEBHOOK_SECRET non configurato — il webhook non sarà verificato.');
    console.warn('   Genera un segreto con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }

  const webhookUrl = `${APP_BASE_URL}/api/telegram/webhook`;
  console.log(`🔗  Registrazione webhook: ${webhookUrl}`);

  const result = await setWebhook(webhookUrl, WEBHOOK_SECRET);
  console.log('✅  Webhook registrato:', result);

  console.log('\n📋  Riepilogo configurazione:');
  console.log('   Webhook URL:       ', webhookUrl);
  console.log('   Secret token:      ', WEBHOOK_SECRET ? '✓ configurato' : '✗ mancante');
  console.log('   Bot username:      ', process.env.TELEGRAM_BOT_USERNAME || '⚠️  non configurato');
  console.log('\n✅  Setup completato. Il bot è pronto.');
}

main().catch(err => {
  console.error('Errore:', err.message);
  process.exit(1);
});
