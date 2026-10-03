#!/usr/bin/env node
require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const supabase = require('../lib/supabase');

async function run() {
  const fileName = '237_psc_coordinatori.sql';
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/', fileName), 'utf8');
  console.log(`Esecuzione ${fileName}...`);
  let { error } = await supabase.rpc('exec_sql', { sql_text: sql });
  if (error) ({ error } = await supabase.rpc('exec_sql', { sql }));
  if (error) { console.error(`Errore su ${fileName}:`, error.message); process.exit(1); }
  await supabase.rpc('exec_sql', { sql_text: "NOTIFY pgrst, 'reload schema';" });
  const { error: mErr } = await supabase.from('_migrations').upsert({ id: 237, file_name: fileName }, { onConflict: 'file_name' });
  if (mErr) console.warn('_migrations:', mErr.message);
  // Bucket privato per PSC, POS ricevuti, foto e firme dei verbali, file importati
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!(buckets || []).some(b => b.name === 'psc-files')) {
    const { error: bErr } = await supabase.storage.createBucket('psc-files', { public: false, fileSizeLimit: 52428800 });
    if (bErr) { console.error('bucket:', bErr.message); process.exit(1); }
    console.log('Bucket psc-files creato (privato).');
  }
  console.log(`${fileName} eseguita con successo.`);
}

run().catch(err => { console.error('Errore fatale:', err.message); process.exit(1); });
