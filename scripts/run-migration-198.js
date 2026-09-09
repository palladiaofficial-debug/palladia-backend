#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/198_weather_rain_threshold_inps_default.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('Esecuzione migration 198_weather_rain_threshold_inps_default.sql...');

  const { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) {
    console.warn('\nRPC non disponibile — esegui manualmente nel Supabase SQL Editor:');
    console.log(sql);
    process.exit(1);
  }

  await supabase.from('_migrations').upsert({ file_name: '198_weather_rain_threshold_inps_default.sql' }, { onConflict: 'file_name' });

  console.log('Migration 198 eseguita con successo.');
  console.log('sites.weather_rain_mm: default colonna passato da 10 a 1 (criteri INPS msg. 28336/1998).');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
