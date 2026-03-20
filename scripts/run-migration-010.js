'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');

async function main() {
  console.log('Migration 010 — Aggiornamento nomi piani');

  // 1. Migra 'base' → 'starter'
  const { data, error } = await supabase
    .from('companies')
    .update({ subscription_plan: 'starter' })
    .eq('subscription_plan', 'base')
    .select('id, name, subscription_plan');

  if (error) {
    console.error('ERRORE UPDATE:', error.message);
    process.exit(1);
  }

  console.log(`UPDATE OK — ${data?.length ?? 0} companies migrate da base → starter`);
  if (data?.length) {
    data.forEach(c => console.log(`  · ${c.name} (${c.id})`));
  }

  // 2. Verifica stato finale
  const { data: all, error: e2 } = await supabase
    .from('companies')
    .select('id, name, subscription_plan, subscription_status');

  if (e2) {
    console.error('ERRORE SELECT:', e2.message);
    process.exit(1);
  }

  console.log('\nStato companies post-migration:');
  all.forEach(c => console.log(`  · ${c.name} — plan=${c.subscription_plan} status=${c.subscription_status}`));

  console.log('\nMigration 010 completata.');
}

main().catch(e => { console.error(e); process.exit(1); });
