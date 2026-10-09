#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/243_caldo_pausa_ritardo.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('Esecuzione migration 243_caldo_pausa_ritardo.sql...');

  const { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) {
    console.warn('\nRPC non disponibile — esegui manualmente nel Supabase SQL Editor:');
    console.log(sql);
    process.exit(1);
  }

  await supabase.from('_migrations').upsert({ file_name: '243_caldo_pausa_ritardo.sql' }, { onConflict: 'file_name' });

  console.log('Migration 243 eseguita con successo.');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
