#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

const FILES = ['202_worker_ai_pseudonym.sql', '203_ladia_ai_pseudonym_log.sql'];

async function run() {
  for (const fileName of FILES) {
    const sqlPath = path.join(__dirname, '../migrations', fileName);
    const sql     = fs.readFileSync(sqlPath, 'utf8');

    console.log(`Esecuzione migration ${fileName}...`);

    const { error } = await supabase.rpc('exec_sql', { sql_text: sql });
    if (error) {
      console.warn('\nRPC non disponibile — esegui manualmente nel Supabase SQL Editor:');
      console.log(sql);
      process.exit(1);
    }

    await supabase.from('_migrations').upsert({ file_name: fileName }, { onConflict: 'file_name' });
    console.log(`Migration ${fileName} eseguita con successo.`);
  }

  console.log('\nF-176/F-177: workers.ai_pseudonym_code e ladia_ai_pseudonym_log pronti.');
}

run().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
