#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const sqlPath = path.join(__dirname, '../migrations/048_company_docs_fix.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  console.log('Esecuzione migration 048_company_docs_fix.sql...');

  const { error } = await supabase.rpc('exec_sql', { sql });

  if (error) {
    console.warn('\nRPC non disponibile — esegui manualmente nel Supabase SQL Editor:');
    console.warn('https://supabase.com/dashboard/project/_/sql\n');
    console.log(sql);
    process.exit(1);
  }

  console.log('Migration 048 eseguita con successo.');
  console.log('Tabella company_documents pronta, categorie aggiornate, RLS abilitato.');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
