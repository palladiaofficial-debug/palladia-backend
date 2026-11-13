#!/usr/bin/env node
/**
 * scripts/selftest_f495_paghe_fuori_documenti.js
 *
 * Regressione per F-495 (AUDIT.md del frontend, 13/11/2026): i prospetti paghe
 * di luglio di MSCedilizia S.r.l. erano in Documenti › Impresa
 * (company_documents, nome «busta_paga», categoria «altro»), dove li aprono i
 * tecnici, il portale coordinatori e i PSC. Le paghe stanno solo in Buste paga
 * (payslips, buste_caricamenti.riepilogo_path): regola F-494.
 *
 * Controllo dal vivo sulle imprese vere (esclude quelle di prova): nessun
 * documento di Documenti dell'impresa o dei cantieri con nome o categoria da
 * busta paga, cedolino, prospetto o riepilogo paghe.
 *
 * Limite: guarda nome e categoria, non il contenuto del PDF.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Se mancano, si salta.
 */
'use strict';
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');

const PAGHE = /bust[ae][ _-]?pag|cedolin|prospett|riepilog\w*[ _-]?pag|libro[ _-]?unico|\blul\b|ci10119/i;
const PROVA = /^(test|e2e)|test-|f184|prova|autoexplore/i;

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}

async function tutte(db, table, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function main() {
  console.log('\nPalladia regression — F-495: niente paghe in Documenti\n');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('  – skip: Supabase non configurato in questo ambiente');
    return;
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const companies = await tutte(db, 'companies', 'id, name');
  const vere = new Map(companies.filter(c => !PROVA.test(c.name || '')).map(c => [c.id, c.name]));

  for (const table of ['company_documents', 'site_documents']) {
    const righe = await tutte(db, table, 'id, company_id, name, category');
    const sbagliate = righe.filter(r => vere.has(r.company_id) && (PAGHE.test(r.name || '') || r.category === 'busta_paga'))
      .map(r => ({ impresa: vere.get(r.company_id), id: r.id, name: r.name, category: r.category }));
    check(`${table}: nessuna busta, cedolino o prospetto paghe nelle imprese vere`, sbagliate.length === 0, sbagliate);
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message); process.exitCode = 1; });
