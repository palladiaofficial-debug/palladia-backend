#!/usr/bin/env node
/**
 * scripts/selftest_pos_crea_no_dead_end.js — F-301 (AUDIT.md del frontend).
 *
 * Il nuovo POS (/pos/crea) si bloccava quando l'anagrafica c'era ma non era
 * collegata al cantiere: subappaltatore non assegnato → vicolo cieco;
 * lavoratori non assegnati → nessun modo di metterli nel POS. Verifica:
 *  - /pos/overview restituisce TUTTI i subappaltatori attivi dell'azienda
 *    (allSubs), anche quelli non assegnati a nessun cantiere; mai quelli di
 *    un'altra azienda né gli archiviati;
 *  - il prefill restituisce gli altri lavoratori della stessa impresa
 *    (otherWorkers), non assegnati al cantiere, con formazione e idoneità;
 *    mai i lavoratori dell'altra impresa (sub ↔ affidataria);
 *  - assegnare un subappaltatore al cantiere dal POS: funziona per un
 *    subappaltatore dell'azienda, è idempotente, rifiuta quello di un'altra
 *    azienda (prima la rotta non lo controllava).
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { buildPosPrefill } = require('../lib/posPrefill');
const { computePosOverview } = require('../lib/posOverview');
const { assignSubcontractorToSite } = require('../lib/siteSubcontractors');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F301-${Date.now()}`;
const stamp = String(Date.now()).slice(-8);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
async function status(p) { try { await p; return 200; } catch (e) { return e.status || 500; } }

async function main() {
  console.log('\n\x1b[1mF-301 — nuovo POS senza vicoli ciechi (subappaltatore e lavoratori non collegati al cantiere)\x1b[0m');
  const company = await ins('companies', { name: T, vat_number: '01234567890' });
  const other = await ins('companies', { name: `${T}-altra` });
  try {
    await ins('company_feature_flags', { company_id: company.id, feature: 'subappaltatori', enabled: true });
    const site = await ins('sites', { company_id: company.id, name: `${T}-Cantiere`, address: 'Via Lucarno 45', status: 'attivo' });
    const sub = await ins('subcontractors', { company_id: company.id, company_name: `${T}-AYAT SRLS`, piva: '13371360960', is_active: true });
    const subArch = await ins('subcontractors', { company_id: company.id, company_name: `${T}-Archiviato`, is_active: false });
    const subOther = await ins('subcontractors', { company_id: other.id, company_name: `${T}-SubAltra`, is_active: true });
    let seq = 0;
    const mk = (n, extra) => { seq++; return ins('workers', { company_id: company.id, full_name: `${T} ${n}`, is_active: true, fiscal_code: `F301${seq}XYZ${stamp}`, badge_code: `F301${seq}X${stamp}`, ...extra }); };
    const wIn = await mk('Assegnato', {});
    const wFree = await mk('Libero', { qualification: 'Muratore', safety_training_expiry: '2030-01-01' });
    const wOff = await mk('Inattivo', { is_active: false });
    const wSubA = await mk('SubUno', { subcontractor_id: sub.id });
    const wSubB = await mk('SubDue', { subcontractor_id: sub.id });
    await ins('worksite_workers', { site_id: site.id, worker_id: wIn.id, status: 'active', company_id: company.id });
    await ins('worksite_workers', { site_id: site.id, worker_id: wSubA.id, status: 'active', company_id: company.id });

    // ── Subappaltatori: tutti quelli dell'azienda, non solo gli assegnati ──
    const ov = await computePosOverview(company.id);
    const all = (ov.allSubs || []).map(s => s.id);
    check('overview: allSubs contiene il subappaltatore NON assegnato al cantiere', all.includes(sub.id), ov.allSubs);
    check('overview: allSubs esclude archiviati e subappaltatori di altre aziende', !all.includes(subArch.id) && !all.includes(subOther.id), ov.allSubs);

    // ── Lavoratori: gli altri della stessa impresa, da aggiungere al POS ──
    const own = await buildPosPrefill(company.id, site.id, null);
    const ownOther = (own.otherWorkers || []).map(w => w.id);
    check('impresa: workers = solo gli assegnati al cantiere', own.workers.length === 1 && own.workers[0].id === wIn.id, own.workers);
    check('impresa: otherWorkers contiene il lavoratore non assegnato, con formazione', ownOther.includes(wFree.id) && own.otherWorkers.find(w => w.id === wFree.id)?.training.status === 'valido' && own.otherWorkers.find(w => w.id === wFree.id)?.qualification === 'Muratore', own.otherWorkers);
    check('impresa: otherWorkers non ripete gli assegnati, esclude inattivi e lavoratori del subappaltatore', !ownOther.includes(wIn.id) && !ownOther.includes(wOff.id) && !ownOther.includes(wSubA.id) && !ownOther.includes(wSubB.id), ownOther);

    const s = await buildPosPrefill(company.id, site.id, sub.id);
    const sOther = (s.otherWorkers || []).map(w => w.id);
    check('subappaltatore: workers = il suo assegnato al cantiere', s.workers.length === 1 && s.workers[0].id === wSubA.id, s.workers);
    check('subappaltatore: otherWorkers = il suo non assegnato, mai quelli dell’impresa', sOther.length === 1 && sOther[0] === wSubB.id, sOther);

    // ── Assegnare il subappaltatore al cantiere direttamente dal POS ──
    check('assegnazione: subappaltatore dell’azienda → ok', await status(assignSubcontractorToSite(company.id, site.id, sub.id)) === 200);
    check('assegnazione ripetuta: idempotente, nessun errore', await status(assignSubcontractorToSite(company.id, site.id, sub.id)) === 200);
    const ov2 = await computePosOverview(company.id);
    const imprese = ov2.sites.find(x => x.id === site.id)?.imprese || [];
    check('dopo l’assegnazione il subappaltatore compare tra le imprese del cantiere', imprese.some(i => i.subcontractorId === sub.id), imprese);
    check('assegnazione: subappaltatore di un’altra azienda → 404', await status(assignSubcontractorToSite(company.id, site.id, subOther.id)) === 404);
    const { data: leak } = await supabase.from('site_subcontractors').select('id').eq('site_id', site.id).eq('subcontractor_id', subOther.id);
    check('nessuna riga creata per il subappaltatore di un’altra azienda', (leak || []).length === 0, leak);
  } finally {
    for (const id of [company.id, other.id]) {
      await supabase.from('site_subcontractors').delete().eq('company_id', id);
      const { data: ss } = await supabase.from('sites').select('id').eq('company_id', id);
      for (const x of ss || []) await supabase.from('worksite_workers').delete().eq('site_id', x.id);
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
