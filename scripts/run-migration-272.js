#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/272_ore_aggiunte.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');
  console.log('Esecuzione migration 272_ore_aggiunte.sql...');
  let { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) ({ error } = await supabase.rpc('exec_sql', { sql }));
  if (error) { console.error('Errore:', error.message); process.exit(1); }
  await supabase.from('_migrations').upsert({ file_name: '272_ore_aggiunte.sql' }, { onConflict: 'file_name' });
  console.log('Migration 272 eseguita con successo.');
}

run().catch(err => { console.error('Errore fatale:', err.message); process.exit(1); });
