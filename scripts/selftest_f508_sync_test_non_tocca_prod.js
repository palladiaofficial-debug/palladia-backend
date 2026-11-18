#!/usr/bin/env node
/**
 * scripts/selftest_f508_sync_test_non_tocca_prod.js
 *
 * Regressione per F-508 (AUDIT.md del frontend, 18/11/2026).
 *
 * I test di sincronizzazione dell'archivio (selftest_documents_sync*.js) per
 * provare che un errore di sync non blocchi il salvataggio mettevano sulla
 * tabella documents di PRODUZIONE un vincolo impossibile, CHECK (1 = 0), per
 * qualche secondo. Ogni salvataggio vero in quella finestra non arrivava
 * nell'archivio (il 18/11 la lettura del capitolato di Via San Nazaro 34).
 *
 *   1. Nessuno script mette su documents un vincolo che vale per tutte le righe:
 *      ogni vincolo di prova vale solo per l'impresa temporanea del test.
 *   2. Dal vivo: dentro la finestra di un vincolo di prova legato a un'impresa,
 *      il salvataggio di un'ALTRA impresa si sincronizza normalmente.
 *   3. Dal vivo: nessun vincolo di prova è rimasto su documents, e nessun
 *      errore di sync mai risolto riguarda un documento di un'impresa vera.
 */
'use strict';
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const PROVA = /^(test|e2e)|test-|f184|prova|autoexplore/i;
let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}

async function main() {
  console.log('\nPalladia regression — F-508: i test di sync non rompono documents per le imprese vere\n');

  // 1. Statico: ogni vincolo di prova su documents è legato all'impresa del test
  const dir = path.join(__dirname);
  const scripts = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== path.basename(__filename));
  const globali = [], legati = [];
  for (const f of scripts) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/ALTER TABLE documents ADD CONSTRAINT[^`'"]*/g)) {
      (/company_id/.test(m[0]) ? legati : globali).push(`${f}: ${m[0].slice(0, 120)}`);
    }
  }
  check('nessuno script mette su documents un vincolo che vale per tutte le righe', globali.length === 0, globali);
  check('i tre test di sync hanno ancora il loro vincolo di prova (legato all\'impresa)', legati.length >= 3, legati);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('  – skip controlli dal vivo: Supabase non configurato');
  } else {
    const supabase = require('../lib/supabase');
    const execSql = async (sql) => {
      let { error } = await supabase.rpc('exec_sql', { sql_text: sql });
      if (error) ({ error } = await supabase.rpc('exec_sql', { sql }));
      return error;
    };

    // 2. Due imprese di prova: il vincolo vale per A, B si salva e si sincronizza
    const { data: cos } = await supabase.from('companies').insert([{ name: 'TEST-F508-A' }, { name: 'TEST-F508-B' }]).select('id, name');
    const A = cos.find(c => c.name === 'TEST-F508-A').id, B = cos.find(c => c.name === 'TEST-F508-B').id;
    const ids = [];
    try {
      const err = await execSql(`ALTER TABLE documents ADD CONSTRAINT test_f508_probe CHECK (company_id IS DISTINCT FROM '${A}'::uuid) NOT VALID;`);
      check('vincolo di prova legato all\'impresa A applicato', !err, err);
      const { data: a } = await supabase.from('company_documents').insert({ company_id: A, name: 'F508 A', category: 'altro', file_path: 'x.pdf' }).select('id').single();
      const { data: b } = await supabase.from('company_documents').insert({ company_id: B, name: 'F508 B', category: 'altro', file_path: 'y.pdf' }).select('id').single();
      ids.push(a?.id, b?.id);
      const { data: da } = await supabase.from('documents').select('id').eq('source_table', 'company_documents').eq('legacy_id', a.id).maybeSingle();
      const { data: db } = await supabase.from('documents').select('id').eq('source_table', 'company_documents').eq('legacy_id', b.id).maybeSingle();
      check('impresa A (quella del test): la sync fallisce come voluto', !da);
      check('impresa B (un\'altra): la sync funziona anche durante il vincolo', !!db);
    } finally {
      await execSql('ALTER TABLE documents DROP CONSTRAINT IF EXISTS test_f508_probe;');
      await supabase.from('document_sync_failures').delete().in('legacy_id', ids.filter(Boolean));
      await supabase.from('company_documents').delete().in('id', ids.filter(Boolean));
      await supabase.from('companies').delete().in('id', [A, B]);
    }

    // 3. Niente vincoli di prova rimasti; nessun errore aperto su imprese vere
    const { data: C } = await supabase.from('companies').insert({ name: 'TEST-F508-C' }).select('id').single();
    const { data: probe } = await supabase.from('company_documents').insert({ company_id: C.id, name: 'F508 C', category: 'altro', file_path: 'z.pdf' }).select('id, company_id').single();
    const { data: dc } = await supabase.from('documents').select('id').eq('source_table', 'company_documents').eq('legacy_id', probe.id).maybeSingle();
    check('nessun vincolo di prova rimasto su documents (un salvataggio nuovo si sincronizza)', !!dc);
    await supabase.from('company_documents').delete().eq('id', probe.id);
    await supabase.from('companies').delete().eq('id', probe.company_id);

    const { data: aperti } = await supabase.from('document_sync_failures').select('id, source_table, legacy_id, error_message').is('resolved_at', null);
    const veri = [];
    for (const f of aperti || []) {
      const { data: src } = await supabase.from(f.source_table).select('company_id').eq('id', f.legacy_id).maybeSingle();
      if (!src?.company_id) continue; // riga di prova già cancellata
      const { data: c } = await supabase.from('companies').select('name').eq('id', src.company_id).maybeSingle();
      if (c && !PROVA.test(c.name || '')) veri.push(`${f.source_table}:${f.legacy_id}:${c.name}`);
    }
    check('nessun errore di sync aperto su un documento di un\'impresa vera', veri.length === 0, veri);
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
