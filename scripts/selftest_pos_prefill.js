#!/usr/bin/env node
/**
 * scripts/selftest_pos_prefill.js — F-258 (AUDIT.md del frontend).
 *
 * "Chi presenta il POS?": per l'impresa o per un suo subappaltatore il
 * sistema precompila dati impresa, figure, lavoratori e cantiere. Verifica:
 *  - il subappaltatore riceve i SUOI dati e i SUOI lavoratori, mai quelli
 *    dell'impresa (e viceversa);
 *  - le figure inserite per il subappaltatore nel suo POS precedente vengono
 *    ricordate;
 *  - le figure di un POS del subappaltatore non finiscono mai nelle figure
 *    precompilate dell'azienda (getCompanyPosDefaults, usato dal vecchio
 *    generatore e da Ladia);
 *  - cantiere o subappaltatore di un'altra azienda: 404.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { buildPosPrefill } = require('../lib/posPrefill');
const { getCompanyPosDefaults } = require('../lib/posDefaults');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F258-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
async function status(p) { try { await p; return 200; } catch (e) { return e.status || 500; } }

async function main() {
  console.log('\n\x1b[1mF-258 — precompilazione del POS per impresa o subappaltatore\x1b[0m');
  const company = await ins('companies', { name: T, vat_number: '01234567890', safety_manager: 'RSPP Azienda' });
  const other = await ins('companies', { name: `${T}-altra` });
  try {
    const site = await ins('sites', { company_id: company.id, name: `${T}-Cantiere`, address: 'Via Test 1', city: 'Genova', status: 'attivo', client_name: 'Condominio Test', start_date: '2026-09-01', end_date: '2027-03-01', shift_start_time: '07:30:00', lunch_break_minutes: 30 });
    const siteOther = await ins('sites', { company_id: other.id, name: `${T}-Altra`, address: 'Via X', status: 'attivo' });
    const sub = await ins('subcontractors', { company_id: company.id, company_name: `${T}-Sub Srls`, piva: '09876543210', legal_address: 'Via Sub 2, Genova', durc_expiry: '2026-12-12' });
    const subOther = await ins('subcontractors', { company_id: other.id, company_name: `${T}-SubAltra` });
    const wOwn = await ins('workers', { company_id: company.id, full_name: `${T} Mario Rossi`, qualification: 'Muratore', is_active: true, fiscal_code: `F258AAAA${stamp}`, badge_code: `F258A${stamp}`, safety_training_expiry: '2020-01-01' });
    const wSub = await ins('workers', { company_id: company.id, full_name: `${T} Karim B`, qualification: 'Intonacatore', is_active: true, subcontractor_id: sub.id, fiscal_code: `F258BBBB${stamp}`, badge_code: `F258B${stamp}`, safety_training_expiry: '2030-01-01' });
    await ins('worksite_workers', { site_id: site.id, worker_id: wOwn.id, status: 'active', company_id: company.id });
    await ins('equipment', { company_id: company.id, name: 'Betoniera 350', type: 'betoniera', is_active: true });

    const own = await buildPosPrefill(company.id, site.id, null);
    check('impresa: dati dell’azienda', own.impresa.kind === 'impresa' && own.impresa.name === T && own.impresa.vat === '01234567890', own.impresa);
    check('impresa: solo i suoi lavoratori, con formazione scaduta segnalata', own.workers.length === 1 && own.workers[0].id === wOwn.id && own.workers[0].training.status === 'scaduto', own.workers);
    check('impresa: mezzi registrati', own.mezzi.includes('Betoniera 350'), own.mezzi);
    check('impresa: RSPP dal responsabile sicurezza dell’azienda', own.figures.rspp.nome === 'RSPP Azienda', own.figures.rspp);
    check('cantiere: indirizzo, committente, date, orari', own.site.address === 'Via Test 1, Genova' && own.site.client === 'Condominio Test' && own.site.startDate === '2026-09-01' && own.site.shiftStart === '07:30' && own.site.lunchMinutes === 30, own.site);

    const s1 = await buildPosPrefill(company.id, site.id, sub.id);
    check('subappaltatore: i suoi dati (ragione sociale, P.IVA, sede, DURC)', s1.impresa.kind === 'subappaltatore' && s1.impresa.name === sub.company_name && s1.impresa.vat === '09876543210' && s1.impresa.durcExpiry === '2026-12-12', s1.impresa);
    check('subappaltatore: i suoi lavoratori (anche se non assegnati al cantiere)', s1.workers.length === 1 && s1.workers[0].id === wSub.id, s1.workers);
    check('subappaltatore: nessun RSPP dell’azienda, nessun mezzo dell’azienda', s1.figures.rspp.nome === '' && s1.mezzi.length === 0 && s1.figuresRemembered === false, { rspp: s1.figures.rspp, mezzi: s1.mezzi });
    check('affidataria indicata nel POS del subappaltatore', s1.affidataria.name === T, s1.affidataria);

    // POS del subappaltatore con le sue figure → ricordate la volta dopo
    await ins('pos_documents', { company_id: company.id, site_id: site.id, revision: 1, content: 'x', pos_data: { subcontractorId: sub.id, companyName: sub.company_name, rspp: 'RSPP Sub', medico: 'Medico Sub', preposto: 'Preposto Sub', datoreLavoro: 'Titolare Sub', cse: 'Geom. CSE', cseTel: '010' } });
    const s2 = await buildPosPrefill(company.id, site.id, sub.id);
    check('figure del subappaltatore ricordate dal suo POS precedente', s2.figuresRemembered && s2.figures.rspp.nome === 'RSPP Sub' && s2.figures.medicoCompetente.nome === 'Medico Sub' && s2.figures.datoreLavoro.nome === 'Titolare Sub', s2.figures);
    const own2 = await buildPosPrefill(company.id, site.id, null);
    check('le figure del subappaltatore NON diventano quelle dell’impresa', own2.figures.rspp.nome === 'RSPP Azienda' && own2.figures.medicoCompetente.nome === '', own2.figures);
    check('coordinatore (CSE) del cantiere riusato anche per l’impresa', own2.site.cse.nome === 'Geom. CSE', own2.site.cse);
    const defs = await getCompanyPosDefaults(company.id);
    check('getCompanyPosDefaults (vecchio generatore, Ladia) ignora i POS dei subappaltatori', defs === null || defs.rspp.nome !== 'RSPP Sub', defs && defs.rspp);

    check('cantiere di un’altra azienda: 404', await status(buildPosPrefill(company.id, siteOther.id, null)) === 404);
    check('subappaltatore di un’altra azienda: 404', await status(buildPosPrefill(company.id, site.id, subOther.id)) === 404);
  } finally {
    for (const id of [company.id, other.id]) {
      await supabase.from('pos_documents').delete().eq('company_id', id);
      const { data: ss } = await supabase.from('sites').select('id').eq('company_id', id);
      for (const s of ss || []) await supabase.from('worksite_workers').delete().eq('site_id', s.id);
      await supabase.from('workers').delete().eq('company_id', id);
      await supabase.from('equipment').delete().eq('company_id', id);
      await supabase.from('subcontractors').delete().eq('company_id', id);
      await supabase.from('sites').delete().eq('company_id', id);
      await supabase.from('companies').delete().eq('id', id);
    }
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
