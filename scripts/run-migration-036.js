#!/usr/bin/env node
/**
 * scripts/run-migration-036.js
 * Esegue la migration 036 (user_site_assignments) su Supabase.
 *
 * Uso:
 *   node scripts/run-migration-036.js
 */

require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/036_user_site_assignments.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('Esecuzione migration 036_user_site_assignments.sql...');

  const { error } = await supabase.rpc('exec_sql', { sql });

  if (error) {
    console.warn('RPC fallita — esegui manualmente su Supabase SQL Editor:');
    console.error('Dettaglio:', error.message);
    console.log('\nhttps://supabase.com/dashboard/project/_/sql\n');
    console.log(sql);
    process.exit(1);
  }

  console.log('Migration 036 eseguita con successo.');
  console.log('\nProssimi passi:');
  console.log('  1. I tecnici usano /i_miei_cantieri nel bot per auto-assegnarsi');
  console.log('  2. In alternativa: INSERT INTO user_site_assignments (company_id, user_id, site_id)');
  console.log('     per assegnazioni manuali');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
