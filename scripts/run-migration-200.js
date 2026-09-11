#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/200_lunch_break_override.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('Esecuzione migration 200_lunch_break_override.sql...');

  const { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) {
    console.warn('\nRPC non disponibile — esegui manualmente nel Supabase SQL Editor:');
    console.log(sql);
    process.exit(1);
  }

  await supabase.from('_migrations').upsert({ file_name: '200_lunch_break_override.sql' }, { onConflict: 'file_name' });

  console.log('Migration 200 eseguita con successo.');
  console.log('Nuova tabella presence_lunch_overrides(company_id, worker_id, work_date, note) — un giorno segnalato "niente pausa" salta la detrazione automatica.');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
