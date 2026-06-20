#!/usr/bin/env node
'use strict';
/**
 * scripts/migrate.js
 * Runner di migrazioni SQL per Supabase.
 *
 * Uso:
 *   node scripts/migrate.js                    — applica tutte le migrazioni non ancora applicate
 *   node scripts/migrate.js --status           — mostra stato migrazioni
 *   node scripts/migrate.js --dry-run          — mostra cosa verrebbe applicato
 *
 * Richiede: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (o SUPABASE_KEY)
 *
 * Le migrazioni vengono ordinate per nome file (non per numero nel prefisso).
 * Lo stato è tracciato nella tabella `_migrations` (creata automaticamente).
 */

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (o SUPABASE_KEY) obbligatorie');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function ensureMigrationsTable() {
  const { error } = await supabase.rpc('ensure_migrations_table');
  if (error) {
    // RPC non esiste ancora — la creiamo inline e poi la tabella
    console.log('Creo tabella _migrations...');
    // Fallback: usa la tabella se esiste, altrimenti il primo run la creerà via SQL Editor
    const { data } = await supabase
      .from('_migrations')
      .select('file_name')
      .limit(1);
    if (data === null) {
      console.error('⚠️  Tabella _migrations non esiste. Esegui prima su SQL Editor:');
      console.error(`
CREATE TABLE IF NOT EXISTS _migrations (
  id         serial PRIMARY KEY,
  file_name  text   NOT NULL UNIQUE,
  applied_at timestamptz NOT NULL DEFAULT now()
);
      `);
      process.exit(1);
    }
  }
}

async function getApplied() {
  const { data, error } = await supabase
    .from('_migrations')
    .select('file_name')
    .order('file_name');
  if (error) { console.error('Errore lettura _migrations:', error.message); process.exit(1); }
  return new Set((data || []).map(r => r.file_name));
}

function getMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

async function showStatus() {
  await ensureMigrationsTable();
  const applied = await getApplied();
  const files   = getMigrationFiles();

  console.log(`\nMigrazioni: ${files.length} file, ${applied.size} applicate\n`);

  for (const f of files) {
    const status = applied.has(f) ? '✅' : '⬜';
    console.log(`  ${status}  ${f}`);
  }

  const pending = files.filter(f => !applied.has(f));
  console.log(`\n${pending.length} da applicare.\n`);
}

async function runMigrations(dryRun = false) {
  await ensureMigrationsTable();
  const applied = await getApplied();
  const files   = getMigrationFiles();
  const pending = files.filter(f => !applied.has(f));

  if (pending.length === 0) {
    console.log('✅ Tutte le migrazioni sono già applicate.');
    return;
  }

  console.log(`${pending.length} migrazioni da applicare:\n`);
  for (const f of pending) {
    console.log(`  → ${f}`);
  }

  if (dryRun) {
    console.log('\n(dry-run — nessuna modifica applicata)');
    return;
  }

  console.log('');
  for (const f of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    process.stdout.write(`  Applico ${f}...`);

    const { error } = await supabase.rpc('exec_sql', { sql_text: sql });
    if (error) {
      console.log(` ❌`);
      console.error(`    Errore: ${error.message}`);
      console.error(`    Migrazione interrotta. Correggi e riesegui.`);
      process.exit(1);
    }

    // Registra come applicata
    await supabase.from('_migrations').insert({ file_name: f });
    console.log(` ✅`);
  }

  console.log(`\n✅ ${pending.length} migrazioni applicate.`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--status')) {
  showStatus().catch(e => { console.error(e); process.exit(1); });
} else if (args.includes('--dry-run')) {
  runMigrations(true).catch(e => { console.error(e); process.exit(1); });
} else {
  runMigrations(false).catch(e => { console.error(e); process.exit(1); });
}
