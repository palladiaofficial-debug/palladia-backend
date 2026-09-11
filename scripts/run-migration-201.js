#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/201_punch_atomic_global_exit.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('Esecuzione migration 201_punch_atomic_global_exit.sql...');

  const { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) {
    console.warn('\nRPC non disponibile — esegui manualmente nel Supabase SQL Editor:');
    console.log(sql);
    process.exit(1);
  }

  await supabase.from('_migrations').upsert({ file_name: '201_punch_atomic_global_exit.sql' }, { onConflict: 'file_name' });

  console.log('Migration 201 eseguita con successo.');
  console.log('punch_atomic ora decide ENTRY/EXIT globalmente per lavoratore, non piu\' per singolo cantiere (F-172).');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
