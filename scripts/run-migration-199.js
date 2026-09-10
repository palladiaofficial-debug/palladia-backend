#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/199_late_entry_threshold.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('Esecuzione migration 199_late_entry_threshold.sql...');

  const { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) {
    console.warn('\nRPC non disponibile — esegui manualmente nel Supabase SQL Editor:');
    console.log(sql);
    process.exit(1);
  }

  await supabase.from('_migrations').upsert({ file_name: '199_late_entry_threshold.sql' }, { onConflict: 'file_name' });

  console.log('Migration 199 eseguita con successo.');
  console.log('companies/sites: shift_start_time, late_entry_threshold_minutes (default 5), late_entry_deduction_minutes (default 30) — regola disattivata finché shift_start_time non è impostato esplicitamente.');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
