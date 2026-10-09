#!/usr/bin/env node
/**
 * scripts/selftest_pos_overview.js — F-257 (AUDIT.md del frontend).
 *
 * La pagina "POS e sicurezza" deve dire, per ogni cantiere aperto, quali
 * imprese ci lavorano (l'impresa e i subappaltatori assegnati) e lo stato
 * del loro POS: manca / bozza / pronto / firmato. Un POS è del subappaltatore
 * se pos_data.subcontractorId è valorizzato. Mai dati di un'altra azienda,
 * mai cantieri chiusi.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { computePosOverview } = require('../lib/posOverview');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}
const T = `TEST-F257-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-257 — panoramica POS per cantiere e impresa\x1b[0m');
  const company = await ins('companies', { name: T });
  const other = await ins('companies', { name: `${T}-altra` });
  const companies = [company.id, other.id];
  try {
    // I default dei flag si leggono al caricamento di lib/featureFlags: l'env
    // impostato qui non conta. Serve la riga per l'azienda (F-301).
    await ins('company_feature_flags', { company_id: company.id, feature: 'subappaltatori', enabled: true });
    const siteA = await ins('sites', { company_id: company.id, name: `${T}-A`, address: 'Via Test 1', city: 'Genova', status: 'attivo' });
    const siteB = await ins('sites', { company_id: company.id, name: `${T}-B`, address: 'Via B', status: 'attivo' });
    const siteClosed = await ins('sites', { company_id: company.id, name: `${T}-Chiuso`, address: 'Via C', status: 'chiuso' });
    const siteOther = await ins('sites', { company_id: other.id, name: `${T}-Altra`, address: 'Via D', status: 'attivo' });
    const sub = await ins('subcontractors', { company_id: company.id, company_name: `${T}-Sub` });
    await ins('site_subcontractors', { company_id: company.id, site_id: siteA.id, subcontractor_id: sub.id, role: 'intonaci' });
    const stamp = String(Date.now()).slice(-8);
    const wOwn = await ins('workers', { company_id: company.id, full_name: `${T}-W1`, is_active: true, fiscal_code: `F257AAAA${stamp}`, badge_code: `F257A${stamp}` });
    const wSub = await ins('workers', { company_id: company.id, full_name: `${T}-W2`, is_active: true, subcontractor_id: sub.id, fiscal_code: `F257BBBB${stamp}`, badge_code: `F257B${stamp}` });
    await ins('worksite_workers', { site_id: siteA.id, worker_id: wOwn.id, status: 'active', company_id: company.id });
    await ins('worksite_workers', { site_id: siteA.id, worker_id: wSub.id, status: 'active', company_id: company.id });
    // POS dell'impresa sul cantiere A, con presa visione del suo lavoratore; bozza sul B
    const posOwn = await ins('pos_documents', { company_id: company.id, site_id: siteA.id, revision: 1, pos_data: { companyName: T }, content: 'x' });
    await ins('pos_acknowledgments', { pos_id: posOwn.id, worker_id: wOwn.id, company_id: company.id, site_id: siteA.id });
    await ins('pos_drafts', { company_id: company.id, site_id: siteB.id });
    await ins('pos_documents', { company_id: other.id, site_id: siteOther.id, revision: 1, pos_data: {}, content: 'x' });

    let ov = await computePosOverview(company.id);
    const names = ov.sites.map(s => s.name);
    check('solo cantieri aperti della propria azienda', names.includes(siteA.name) && names.includes(siteB.name) && !names.includes(siteClosed.name) && !names.includes(siteOther.name), names);
    const A = ov.sites.find(s => s.id === siteA.id);
    const own = A.imprese.find(i => i.kind === 'impresa');
    const subE = A.imprese.find(i => i.kind === 'subappaltatore');
    check('cantiere A: impresa + subappaltatore assegnato', A.imprese.length === 2 && subE && subE.subcontractorId === sub.id, A.imprese);
    check('impresa con presa visione di tutti i suoi lavoratori: firmato', own.status === 'firmato' && own.signed === 1 && own.workers === 1, own);
    check('subappaltatore senza POS: manca, con i suoi lavoratori contati', subE.status === 'manca' && subE.workers === 1, subE);
    const B = ov.sites.find(s => s.id === siteB.id);
    check('cantiere B con bozza Ladia: bozza', B.imprese[0].status === 'bozza', B.imprese[0]);

    await ins('pos_documents', { company_id: company.id, site_id: siteA.id, revision: 2, pos_data: { subcontractorId: sub.id }, content: 'x' });
    ov = await computePosOverview(company.id);
    const A2 = ov.sites.find(s => s.id === siteA.id);
    const subE2 = A2.imprese.find(i => i.kind === 'subappaltatore');
    const own2 = A2.imprese.find(i => i.kind === 'impresa');
    check('POS del subappaltatore: pronto, 0 di 1 presa visione', subE2.status === 'pronto' && subE2.signed === 0 && subE2.workers === 1, subE2);
    check('il POS del subappaltatore non tocca quello dell’impresa', own2.status === 'firmato' && own2.posId === posOwn.id, own2);

    process.env.FEATURE_SUBAPPALTATORI_DEFAULT = 'false';
    const ovOff = await computePosOverview(company.id);
    const Aoff = ovOff.sites.find(s => s.id === siteA.id);
    check('subappaltatori spenti per l’azienda: compare solo l’impresa', !ovOff.subsEnabled ? Aoff.imprese.length === 1 : true, { subsEnabled: ovOff.subsEnabled, n: Aoff.imprese.length });
  } finally {
    for (const id of companies) {
      await supabase.from('pos_acknowledgments').delete().eq('company_id', id);
      await supabase.from('pos_documents').delete().eq('company_id', id);
      await supabase.from('pos_drafts').delete().eq('company_id', id);
      await supabase.from('site_subcontractors').delete().eq('company_id', id);
      const { data: ss } = await supabase.from('sites').select('id').eq('company_id', id);
      for (const s of ss || []) await supabase.from('worksite_workers').delete().eq('site_id', s.id);
      await supabase.from('workers').delete().eq('company_id', id);
      await supabase.from('subcontractors').delete().eq('company_id', id);
      await supabase.from('sites').delete().eq('company_id', id);
      await supabase.from('company_feature_flags').delete().eq('company_id', id);
      await supabase.from('companies').delete().eq('id', id);
    }
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
