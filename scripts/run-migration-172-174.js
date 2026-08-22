#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function runOne(fileName) {
  const sqlPath = path.join(__dirname, '../migrations/', fileName);
  const sql     = fs.readFileSync(sqlPath, 'utf8');
  console.log(`Esecuzione ${fileName}...`);
  let { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) ({ error } = await supabase.rpc('exec_sql', { sql }));
  if (error) {
    console.error(`Errore su ${fileName}:`, error.message);
    process.exit(1);
  }
  await supabase.from('_migrations').upsert({ file_name: fileName }, { onConflict: 'file_name' });
  console.log(`${fileName} eseguita con successo.`);
}

async function run() {
  await runOne('172_documents_tier4_schema.sql');
  await runOne('173_documents_tier4_sync_triggers.sql');
  await runOne('174_documents_sync_verify_function_v4.sql');
  console.log('Migrazioni 172-174: documenti unificati, Scaglione 4 (equipment_documents/mezzi).');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
