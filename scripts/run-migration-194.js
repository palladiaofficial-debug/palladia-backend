#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/194_realtime_cross_user_sync.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('Esecuzione migration 194_realtime_cross_user_sync.sql...');

  const { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) {
    console.warn('\nRPC non disponibile — esegui manualmente nel Supabase SQL Editor:');
    console.log(sql);
    process.exit(1);
  }

  await supabase.from('_migrations').upsert({ file_name: '194_realtime_cross_user_sync.sql' }, { onConflict: 'file_name' });

  console.log('Migration 194 eseguita con successo.');
  console.log('Realtime abilitato su: workers, worksite_workers, equipment, subcontractors, site_documents, site_notes, site_diary_entries, site_costs, site_economia_voci, site_sal_history, worker_certificates.');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
