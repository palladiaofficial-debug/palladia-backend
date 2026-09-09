#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/197_weather_era5_reconciliation.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('Esecuzione migration 197_weather_era5_reconciliation.sql...');

  const { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) {
    console.warn('\nRPC non disponibile — esegui manualmente nel Supabase SQL Editor:');
    console.log(sql);
    process.exit(1);
  }

  await supabase.from('_migrations').upsert({ file_name: '197_weather_era5_reconciliation.sql' }, { onConflict: 'file_name' });

  console.log('Migration 197 eseguita con successo.');
  console.log('site_weather_logs: aggiunte data_source, era5_reconciled_at, precipitation_mm_original, wind_max_kmh_original, weather_code_original, era5_discrepancy.');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
