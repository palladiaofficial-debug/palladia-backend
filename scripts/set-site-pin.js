#!/usr/bin/env node
/**
 * scripts/set-site-pin.js
 *
 * Imposta o aggiorna il PIN di un cantiere (salvato come bcrypt hash).
 *
 * Uso:
 *   node scripts/set-site-pin.js <site_id> <pin>
 *
 * Env richieste: SUPABASE_URL, SUPABASE_KEY
 *
 * Esempio:
 *   node scripts/set-site-pin.js "550e8400-e29b-41d4-a716-446655440000" "1234"
 */
'use strict';
require('dotenv').config();

const { hashPin } = require('../lib/pinHash');
const { createClient } = require('@supabase/supabase-js');

const [,, siteId, pin] = process.argv;

if (!siteId || !pin) {
  console.error('Uso: node scripts/set-site-pin.js <site_id> <pin>');
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('Env mancanti: SUPABASE_URL, SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function main() {
  let pinHash;
  try {
    pinHash = await hashPin(pin);
  } catch (e) {
    console.error('Errore hash PIN:', e.message);
    process.exit(1);
  }

  const { data, error } = await supabase
    .from('sites')
    .update({ pin_hash: pinHash })
    .eq('id', siteId)
    .select('id, name')
    .single();

  if (error) {
    console.error('Errore Supabase:', error.message);
    process.exit(1);
  }
  console.log(`✓ PIN aggiornato per cantiere: "${data.name}" (${data.id})`);
  console.log(`  pin_hash: ${pinHash.slice(0, 16)}... (troncato per sicurezza)`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
