#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/209_punch_atomic_drop_stale_overload.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('Esecuzione migration 209_punch_atomic_drop_stale_overload.sql...');

  const { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) {
    console.warn('\nRPC non disponibile — esegui manualmente nel Supabase SQL Editor:');
    console.log(sql);
    process.exit(1);
  }

  await supabase.from('_migrations').upsert({ file_name: '209_punch_atomic_drop_stale_overload.sql' }, { onConflict: 'file_name' });

  console.log('Migration 209 eseguita con successo — overload obsoleto di punch_atomic rimosso.');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
