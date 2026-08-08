#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/149_rls_documenti_mancanti.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('Esecuzione migration 149_rls_documenti_mancanti.sql...');

  let { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) {
    console.warn('exec_sql(sql_text) fallito, provo con parametro sql:', error.message);
    ({ error } = await supabase.rpc('exec_sql', { sql }));
  }

  if (error) {
    console.warn('\nRPC non disponibile — esegui manualmente nel Supabase SQL Editor:');
    console.warn('https://supabase.com/dashboard/project/_/sql\n');
    console.log(sql);
    process.exit(1);
  }

  await supabase.from('_migrations').upsert({ file_name: '149_rls_documenti_mancanti.sql' }, { onConflict: 'file_name' });

  console.log('Migration 149 eseguita con successo.');
  console.log('RLS + policy is_company_member su worker_certificates, durc_records, studio_shared_documents, studio_document_requests.');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
