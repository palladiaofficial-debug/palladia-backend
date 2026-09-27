#!/usr/bin/env node
/**
 * scripts/selftest_pos_for_worker.js — F-260 (AUDIT.md del frontend).
 *
 * In timbratura il lavoratore prende visione del POS della SUA impresa.
 *  1) Dati come prima di F-258 (nessun POS di subappaltatori): tutti vedono
 *     l'ultimo POS del cantiere, esattamente come la vecchia query.
 *  2) Dopo un POS del subappaltatore: i lavoratori dell'impresa continuano a
 *     vedere il POS dell'impresa; quelli del subappaltatore il loro.
 *  3) Subappaltatore senza POS proprio: vede il POS dell'impresa (come prima).
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { latestPosForWorker } = require('../lib/posForWorker');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
}
const T = `TEST-F260-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('\n\x1b[1mF-260 — POS da firmare in timbratura: quello della propria impresa\x1b[0m');
  const company = await ins('companies', { name: T });
  try {
    const site = await ins('sites', { company_id: company.id, name: T, address: 'Via 1', status: 'attivo' });
    const subA = await ins('subcontractors', { company_id: company.id, company_name: `${T}-A` });
    const subB = await ins('subcontractors', { company_id: company.id, company_name: `${T}-B` });
    const wOwn = await ins('workers', { company_id: company.id, full_name: `${T} own`, is_active: true, fiscal_code: `F260AAAA${stamp}`, badge_code: `F260A${stamp}` });
    const wA = await ins('workers', { company_id: company.id, full_name: `${T} a`, is_active: true, subcontractor_id: subA.id, fiscal_code: `F260BBBB${stamp}`, badge_code: `F260B${stamp}` });
    const wB = await ins('workers', { company_id: company.id, full_name: `${T} b`, is_active: true, subcontractor_id: subB.id, fiscal_code: `F260CCCC${stamp}`, badge_code: `F260C${stamp}` });

    check('nessun POS: nessuna presa visione', (await latestPosForWorker(site.id, wOwn.id)) === null);
    const p1 = await ins('pos_documents', { company_id: company.id, site_id: site.id, revision: 1, pos_data: {}, content: 'x' });
    await sleep(20);
    const p2 = await ins('pos_documents', { company_id: company.id, site_id: site.id, revision: 2, pos_data: { companyName: T }, content: 'x' });
    const old = async () => (await supabase.from('pos_documents').select('id').eq('site_id', site.id).order('created_at', { ascending: false }).limit(1).maybeSingle()).data?.id;
    const oldQuery = await old();
    check('dati di oggi: impresa = vecchia query (ultimo POS)', (await latestPosForWorker(site.id, wOwn.id))?.id === oldQuery && oldQuery === p2.id);
    check('dati di oggi: lavoratore del subappaltatore = vecchia query', (await latestPosForWorker(site.id, wA.id))?.id === oldQuery);

    await sleep(20);
    const pA = await ins('pos_documents', { company_id: company.id, site_id: site.id, revision: 3, pos_data: { subcontractorId: subA.id }, content: 'x' });
    check('dopo il POS di A: l’impresa firma ancora il suo POS', (await latestPosForWorker(site.id, wOwn.id))?.id === p2.id);
    check('dopo il POS di A: i lavoratori di A firmano il POS di A', (await latestPosForWorker(site.id, wA.id))?.id === pA.id);
    check('B senza POS proprio: vede il POS dell’impresa, come prima', (await latestPosForWorker(site.id, wB.id))?.id === p2.id);
    check('lavoratore inesistente: POS dell’impresa, nessun errore', (await latestPosForWorker(site.id, '00000000-0000-0000-0000-000000000000'))?.id === p2.id);
    void p1;
  } finally {
    await supabase.from('pos_documents').delete().eq('company_id', company.id);
    await supabase.from('workers').delete().eq('company_id', company.id);
    await supabase.from('subcontractors').delete().eq('company_id', company.id);
    await supabase.from('sites').delete().eq('company_id', company.id);
    await supabase.from('companies').delete().eq('id', company.id);
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
