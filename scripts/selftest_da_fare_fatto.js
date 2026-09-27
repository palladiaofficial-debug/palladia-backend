#!/usr/bin/env node
/**
 * scripts/selftest_da_fare_fatto.js — F-246 (AUDIT.md), "Fatto" su Da fare.
 *
 * "Fatto" deve dire al sistema che il rinnovo c'è: la nuova scadenza va
 * scritta dove il sistema la legge, quindi la riga sparisce da Da fare e lo
 * stato del lavoratore torna in regola. Per le righe documento la data va
 * nella tabella di origine (la copia `documents` si riallinea coi trigger) e
 * il campo del titolare più vecchio va portato avanti. Non deve mai toccare
 * righe di un'altra azienda, né accettare date passate.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { buildDaFare, romeDate, addDays } = require('../lib/daFare');
const { segnaFatto } = require('../lib/daFareFatto');
const { overallStatus } = require('../lib/compliance');

let passed = 0, failed = 0;
function ok(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

const T = `TEST-F246-${Date.now()}`;
const today = romeDate();
const d = n => addDays(today, n);

async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}
async function rejects(name, p, code) {
  try { await p; fail(name, 'nessun errore'); } catch (e) { check(name, e.code === code, e.code || e.message); }
}

async function main() {
  console.log('\n\x1b[1mF-246 — "Fatto" su Da fare scrive la nuova scadenza dove il sistema la legge\x1b[0m');
  const company = await ins('companies', { name: T, durc_expiry: d(-3) });
  const other = await ins('companies', { name: `${T}-altra` });
  const cid = company.id;
  try {
    const wA = await ins('workers', { company_id: cid, full_name: `${T} Anna`, is_active: true, fiscal_code: `F246A${Date.now()}`.slice(0, 16), badge_code: `F246A${Date.now()}`, health_fitness_expiry: d(-5), safety_training_expiry: d(300) });
    const wB = await ins('workers', { company_id: cid, full_name: `${T} Bruno`, is_active: true, fiscal_code: `F246B${Date.now()}`.slice(0, 16), badge_code: `F246B${Date.now()}`, health_fitness_expiry: d(-2), safety_training_expiry: d(300) });
    const bDoc = await ins('worker_documents', { company_id: cid, worker_id: wB.id, doc_type: 'idoneita', name: 'Idoneità Bruno', file_path: `test/${T}/b.pdf`, expiry_date: d(-2) });
    const eq = await ins('equipment', { company_id: cid, type: 'Furgone', model: `${T} Ducato`, ownership: 'Aziendale', is_active: true, insurance_expiry: d(4) });
    const site = await ins('sites', { company_id: cid, name: `${T} Cantiere`, address: 'Via Test 1, Genova', status: 'attivo', end_date: d(-1) });
    const wOther = await ins('workers', { company_id: other.id, full_name: `${T} Estraneo`, is_active: true, fiscal_code: `F246X${Date.now()}`.slice(0, 16), badge_code: `F246X${Date.now()}`, health_fitness_expiry: d(-1) });

    const before = await buildDaFare(cid, null, { todayStr: today });
    const byId = new Map(before.items.map(i => [i.id, i]));
    const docItem = before.items.find(i => i.id.startsWith('doc:') && i.title.includes('Bruno'));
    check('prima: idoneità di Anna (campo) in lista e segnabile come fatta', byId.get(`worker:${wA.id}:idoneita`)?.fattibile === true, byId.get(`worker:${wA.id}:idoneita`));
    check('prima: idoneità di Bruno (documento) in lista e segnabile', docItem?.fattibile === true, docItem);
    check('prima: DURC aziendale in lista', byId.has('company:durc'));
    check('fine lavori NON segnabile come fatta (non è un rinnovo)', byId.get(`site:${site.id}:fine`)?.fattibile === false, byId.get(`site:${site.id}:fine`));

    // Prenotata + poi Fatto: la prenotazione sparisce
    await ins('da_fare_prenotazioni', { company_id: cid, item_id: `worker:${wA.id}:idoneita`, torna_il: d(7) });

    await rejects('data passata rifiutata', segnaFatto({ companyId: cid, itemId: `worker:${wA.id}:idoneita`, nuovaScadenza: d(-1) }), 'DATE_NOT_FUTURE');
    await rejects('data di oggi rifiutata', segnaFatto({ companyId: cid, itemId: `worker:${wA.id}:idoneita`, nuovaScadenza: today }), 'DATE_NOT_FUTURE');
    await rejects('data inesistente rifiutata', segnaFatto({ companyId: cid, itemId: `worker:${wA.id}:idoneita`, nuovaScadenza: '2027-02-30' }), 'INVALID_DATE');
    await rejects('fine lavori rifiutata', segnaFatto({ companyId: cid, itemId: `site:${site.id}:fine`, nuovaScadenza: d(30) }), 'INVALID_ITEM');
    await rejects('lavoratore di un\'altra azienda: non trovato', segnaFatto({ companyId: cid, itemId: `worker:${wOther.id}:idoneita`, nuovaScadenza: d(365) }), 'NOT_FOUND');
    const { data: estraneo } = await supabase.from('workers').select('health_fitness_expiry').eq('id', wOther.id).single();
    check('...e la sua data non è cambiata', estraneo.health_fitness_expiry === d(-1), estraneo);

    const rA = await segnaFatto({ companyId: cid, itemId: `worker:${wA.id}:idoneita`, nuovaScadenza: d(365) });
    const { data: anna } = await supabase.from('workers').select('is_active, health_fitness_expiry, safety_training_expiry').eq('id', wA.id).single();
    check('Anna: campo idoneità aggiornato', anna.health_fitness_expiry === d(365), anna);
    check('Anna: stato complessivo tornato in regola', overallStatus(anna) === 'compliant', overallStatus(anna));
    check('Anna: riverifica conformità nel risultato', rA.recheck?.idoneita_medica?.scadenza === d(365), rA.recheck);
    const { data: pren } = await supabase.from('da_fare_prenotazioni').select('item_id').eq('company_id', cid);
    check('prenotazione della riga tolta', (pren || []).length === 0, pren);

    const rB = await segnaFatto({ companyId: cid, itemId: docItem.id, nuovaScadenza: d(365) });
    const { data: bRow } = await supabase.from('worker_documents').select('expiry_date').eq('id', bDoc.id).single();
    check('Bruno: scadenza scritta nella tabella di origine', bRow.expiry_date === d(365), bRow);
    const { data: bUnified } = await supabase.from('documents').select('expiry_date').eq('id', docItem.id.slice(4)).single();
    check('Bruno: la copia unificata si è riallineata (trigger)', bUnified.expiry_date === d(365), bUnified);
    const { data: bruno } = await supabase.from('workers').select('health_fitness_expiry').eq('id', wB.id).single();
    check('Bruno: campo del lavoratore portato avanti (lo legge la conformità)', bruno.health_fitness_expiry === d(365), { bruno, ownerSync: rB.ownerSync });

    await segnaFatto({ companyId: cid, itemId: `equipment:${eq.id}:assicurazione`, nuovaScadenza: d(366) });
    await segnaFatto({ companyId: cid, itemId: 'company:durc', nuovaScadenza: d(120) });
    const { data: co } = await supabase.from('companies').select('durc_expiry').eq('id', cid).single();
    check('DURC aziendale aggiornato', co.durc_expiry === d(120), co);
    const { data: otherCo } = await supabase.from('companies').select('durc_expiry').eq('id', other.id).single();
    check('DURC dell\'altra azienda intatto', otherCo.durc_expiry === null, otherCo);

    const after = await buildDaFare(cid, null, { todayStr: today });
    const ids = new Set(after.items.map(i => i.id));
    check('dopo: idoneità di Anna fuori da Da fare', !ids.has(`worker:${wA.id}:idoneita`));
    check('dopo: idoneità di Bruno fuori da Da fare', !ids.has(docItem.id) && !ids.has(`worker:${wB.id}:idoneita`), after.items.map(i => i.title));
    check('dopo: assicurazione del furgone fuori', !ids.has(`equipment:${eq.id}:assicurazione`));
    check('dopo: DURC aziendale fuori', !ids.has('company:durc'));
    check('dopo: fine lavori ancora lì (non toccata)', ids.has(`site:${site.id}:fine`));
    check('campanella scesa', after.attention < before.attention, { prima: before.attention, dopo: after.attention });

    const { data: audit } = await supabase.from('admin_audit_log').select('action, payload').eq('company_id', cid).eq('action', 'da_fare.fatto');
    check('4 scritture nel registro attività', (audit || []).length === 4, audit);
    const aA = (audit || []).find(a => a.payload?.itemId === `worker:${wA.id}:idoneita`);
    check('registro: data vecchia e nuova', aA?.payload?.prima === d(-5) && aA?.payload?.dopo === d(365), aA);
  } finally {
    for (const t of ['worker_documents', 'da_fare_prenotazioni', 'admin_audit_log']) {
      await supabase.from(t).delete().eq('company_id', cid);
    }
    await supabase.from('documents').delete().eq('company_id', cid);
  }
  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
