#!/usr/bin/env node
/**
 * scripts/selftest_lavagna_in_corso.js — F-334 (AUDIT.md del frontend).
 *
 * Gli avvisi della lavagna ("Visita medica scaduta · …", "Manca il POS") si
 * chiudono con "Già in corso": la stessa prenotazione di Da fare (F-243), così
 * la cosa sparisce insieme da lavagna, Da fare, campanella e card di Ladia, e
 * torna da sola alla data scelta.
 *   - prenotata in Da fare → sparisce anche dalla lavagna (riga del campo e
 *     riga del documento);
 *   - "Già in corso" dalla lavagna → la riga di Da fare passa in "In corso";
 *   - "Manca il POS" si mette da parte per il cantiere;
 *   - annullare la riporta; una prenotazione scaduta non conta.
 */
'use strict';
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const L = require('../lib/lavagna');
const { buildDaFare, romeDate, addDays } = require('../lib/daFare');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
const T = `TEST-F334-${Date.now()}`;
const today = romeDate();
const d = n => addDays(today, n);
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-334 — Lavagna: avvisi "Già in corso"\x1b[0m');
  const company = await ins('companies', { name: T, subscription_plan: 'starter', subscription_status: 'active' });
  const cid = company.id;
  const userId = crypto.randomUUID();
  try {
    const site = await ins('sites', { company_id: cid, name: `${T} Via Riboli 4b`, address: '', status: 'attivo' });
    const stamp = String(Date.now()).slice(-8);
    const anna = await ins('workers', { company_id: cid, full_name: `${T} Anna`, is_active: true, fiscal_code: `F334A${stamp}`.slice(0, 16), badge_code: `F334A${stamp}`, health_fitness_expiry: d(-20), safety_training_expiry: d(300) });
    const bruno = await ins('workers', { company_id: cid, full_name: `${T} Bruno`, is_active: true, fiscal_code: `F334B${stamp}`.slice(0, 16), badge_code: `F334B${stamp}`, health_fitness_expiry: d(300), safety_training_expiry: d(-15) });
    // Bruno ha anche il documento della formazione, stessa data: in Da fare è la riga "doc:…"
    await ins('worker_documents', { company_id: cid, worker_id: bruno.id, doc_type: 'formazione', name: 'Corso sicurezza Bruno', file_path: `test/${T}/b.pdf`, expiry_date: d(-15) });
    const y = d(-1);
    for (const w of [anna, bruno]) {
      await ins('presence_logs', { company_id: cid, site_id: site.id, worker_id: w.id, event_type: 'ENTRY', timestamp_server: `${y}T06:00:00Z`, method: 'worker_self_punch' });
      await ins('presence_logs', { company_id: cid, site_id: site.id, worker_id: w.id, event_type: 'EXIT', timestamp_server: `${y}T15:00:00Z`, method: 'worker_self_punch' });
    }

    const riga = async () => (await L.lavagna(cid)).righe.find(r => r.siteId === site.id);
    const testi = (r) => (r?.avvisi || []).map(a => a.testo);
    let r = await riga();
    const aAnna = r?.avvisi?.find(a => /Visita medica/.test(a.testo) && /Anna/.test(a.testo));
    const aBruno = r?.avvisi?.find(a => /Formazione/.test(a.testo) && /Bruno/.test(a.testo));
    const aPos = r?.avvisi?.find(a => a.testo === 'Manca il POS');
    check('avvisi con la loro chiave: visita di Anna, formazione di Bruno, POS', !!aAnna?.chiave && !!aBruno?.chiave && !!aPos?.chiave, r?.avvisi);
    if (!aAnna?.chiave) throw new Error('avvisi senza chiave: inutile proseguire');

    // 1. Prenotata in Da fare (come fa la pagina Da fare) → sparisce dalla lavagna
    const df = await buildDaFare(cid, userId);
    const itBruno = df.items.find(i => i.entityId === bruno.id && i.type === 'formazione');
    check('Da fare: la formazione di Bruno è la riga del documento', itBruno?.id?.startsWith('doc:'), itBruno);
    await supabase.from('da_fare_prenotazioni').insert({ company_id: cid, item_id: itBruno.id, torna_il: d(10) });
    r = await riga();
    check('prenotata in Da fare → non è più sulla lavagna', !testi(r).some(t => /Bruno/.test(t)), testi(r));

    // 2. "Già in corso" dalla lavagna → In corso anche in Da fare
    await L.inCorso(cid, userId, { siteId: site.id, chiavi: [aAnna.chiave], giorni: 14 });
    r = await riga();
    check('"Già in corso" dalla lavagna → l\'avviso sparisce', !testi(r).some(t => /Anna/.test(t)), testi(r));
    const df2 = await buildDaFare(cid, userId);
    const itAnna = df2.items.find(i => i.entityId === anna.id && i.type === 'idoneita');
    check('…e in Da fare la visita di Anna è "In corso" fino a +14 giorni', itAnna?.bucket === 'in_corso' && itAnna.prenotataFino === d(14), itAnna);

    // 3. "Manca il POS"
    await L.inCorso(cid, userId, { siteId: site.id, chiavi: [aPos.chiave], giorni: 7 });
    r = await riga();
    check('"Manca il POS" messo da parte per il cantiere', !testi(r).includes('Manca il POS'), testi(r));

    // 4. Annulla: torna
    await L.annullaInCorso(cid, { siteId: site.id, chiavi: [aAnna.chiave, aPos.chiave] });
    r = await riga();
    check('annullato → visita di Anna e POS tornano', testi(r).some(t => /Anna/.test(t)) && testi(r).includes('Manca il POS'), testi(r));

    // 5. Prenotazione scaduta: non conta
    await supabase.from('da_fare_prenotazioni').update({ torna_il: d(-1) }).eq('company_id', cid).eq('item_id', itBruno.id);
    r = await riga();
    check('prenotazione scaduta → l\'avviso torna', testi(r).some(t => /Bruno/.test(t)), testi(r));

    // 6. Chiavi non valide o di un altro cantiere
    let err = null;
    try { await L.inCorso(cid, userId, { siteId: site.id, chiavi: ['worker:zzz;drop'], giorni: 7 }); } catch (e) { err = e; }
    check('chiave non valida rifiutata', err?.code === 'INVALID_CHIAVE', err?.message);
    err = null;
    try { await L.inCorso(cid, userId, { siteId: site.id, chiavi: [aAnna.chiave], giorni: 90 }); } catch (e) { err = e; }
    check('giorni fuori da 1-60 rifiutati', err?.code === 'INVALID_GIORNI', err?.message);
  } finally {
    for (const t of ['da_fare_prenotazioni', 'worker_documents', 'lavagna_righe']) await supabase.from(t).delete().eq('company_id', cid);
    await supabase.from('documents').delete().eq('company_id', cid);
    // presence_logs append-only: le righe di prova restano sull'azienda TEST-
  }
  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
