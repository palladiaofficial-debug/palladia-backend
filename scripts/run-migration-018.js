#!/usr/bin/env node
/**
 * scripts/run-migration-018.js
 * Esegue la migration 018 (tabelle Telegram) su Supabase.
 *
 * Uso:
 *   node scripts/run-migration-018.js
 */

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const supabase  = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/018_telegram.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('🔄  Esecuzione migration 018_telegram.sql...');

  const { error } = await supabase.rpc('exec_sql', { sql });

  if (error) {
    // Prova con Management API se RPC fallisce
    const managementUrl = `${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`;
    console.warn('⚠️  RPC fallita, provo Management API...');
    console.error('   Dettaglio:', error.message);
    console.log('\n📋  Esegui manualmente su Supabase SQL Editor:');
    console.log('   https://supabase.com/dashboard/project/_/sql\n');
    console.log(sql);
    process.exit(1);
  }

  console.log('✅  Migration 018 eseguita con successo.');
  console.log('\n📋  Prossimi passi:');
  console.log('   1. Crea il bucket Supabase Storage "site-media" (pubblico per lettura)');
  console.log('      → Supabase Dashboard → Storage → New bucket → name: site-media → Public: ✓');
  console.log('   2. Configura su Railway:');
  console.log('      TELEGRAM_BOT_TOKEN=<token dal BotFather>');
  console.log('      TELEGRAM_WEBHOOK_SECRET=<stringa casuale 32+ char>');
  console.log('      TELEGRAM_BOT_USERNAME=<username del bot senza @>');
  console.log('   3. Dopo il deploy, registra il webhook:');
  console.log('      node scripts/setup-telegram-webhook.js');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
