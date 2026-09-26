#!/usr/bin/env node
/**
 * scripts/selftest_da_fare.js — F-236 (AUDIT.md), Le quattro porte passo 2.
 *
 * La porta "Da fare" è la lista unica delle cose da sistemare (lib/daFare.js).
 * Il rischio vero non è che manchi una riga ma che ne compaiano di sbagliate o
 * doppie: un DURC già rinnovato ancora in lista, la stessa idoneità due volte
 * (campo del lavoratore + documento), un subappaltatore di un modulo congelato,
 * un cantiere chiuso, un'uscita automatica già corretta a mano. Qui ogni caso
 * è seminato su dati reali (azienda TEST-) e controllato sulla lista prodotta.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const supabase = require('../lib/supabase');
const { buildDaFare, romeDate, addDays } = require('../lib/daFare');

let passed = 0, failed = 0;
function ok(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

const T = `TEST-F236-${Date.now()}`;
const today = romeDate();
const d = n => addDays(today, n);

async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-236 — Da fare: lista unica senza doppioni né moduli congelati\x1b[0m');
  const company = await ins('companies', { name: T, durc_expiry: d(-3) });
  const cid = company.id;
  const userId = crypto.randomUUID();
  const created = { workers: [], sites: [], equipment: [], subs: [] };
  try {
    const wA = await ins('workers', { company_id: cid, full_name: `${T} Anna`, is_active: true, fiscal_code: `F236A${Date.now()}`.slice(0, 16), badge_code: `F236A${Date.now()}`, health_fitness_expiry: d(3), safety_training_expiry: d(-10) });
    const wB = await ins('workers', { company_id: cid, full_name: `${T} Bruno`, is_active: true, fiscal_code: `F236B${Date.now()}`.slice(0, 16), badge_code: `F236B${Date.now()}` });
    const wOff = await ins('workers', { company_id: cid, full_name: `${T} Disattivo`, is_active: false, fiscal_code: `F236C${Date.now()}`.slice(0, 16), badge_code: `F236C${Date.now()}`, health_fitness_expiry: d(-1) });
    created.workers.push(wA.id, wB.id, wOff.id);

    const sOpen = await ins('sites', { company_id: cid, name: `${T} Cantiere aperto`, address: 'Via Test 1, Genova', status: 'attivo', end_date: d(-5) });
    const sClosed = await ins('sites', { company_id: cid, name: `${T} Cantiere chiuso`, address: 'Via Test 2, Genova', status: 'chiuso', end_date: d(-40) });
    created.sites.push(sOpen.id, sClosed.id);

    const eq = await ins('equipment', { company_id: cid, type: 'Furgone', model: `${T} Ducato`, ownership: 'Aziendale', is_active: true, inspection_date: d(-6), insurance_expiry: d(200) });
    created.equipment.push(eq.id);

    // Documenti: idoneità di Anna con la STESSA data del campo → una riga sola
    const idon = await ins('worker_documents', { company_id: cid, worker_id: wA.id, doc_type: 'idoneita', name: 'Idoneità Anna', file_path: `test/${T}/idon.pdf`, expiry_date: d(3) });
    // DURC: uno vecchio scaduto e uno rinnovato valido → nessuna riga DURC documento
    await ins('company_documents', { company_id: cid, name: 'DURC vecchio', category: 'durc', file_path: `test/${T}/durc1.pdf`, ai_expiry_date: d(-3) });
    await ins('company_documents', { company_id: cid, name: 'DURC nuovo', category: 'durc', file_path: `test/${T}/durc2.pdf`, ai_expiry_date: d(110) });
    // Documento di Bruno in scadenza e con notifica "già prenotato" → sezione In corso
    const bDoc = await ins('worker_documents', { company_id: cid, worker_id: wB.id, doc_type: 'altro', name: 'Corso ponteggi Bruno', file_path: `test/${T}/b.pdf`, expiry_date: d(12) });
    await ins('notifications', { company_id: cid, type: 'worker_doc_expiry', severity: 'warning', title: 'Bruno — corso', entity_type: 'worker_document', entity_id: String(bDoc.id), read_by: [], snoozed_until: d(10) });
    // Documento del lavoratore disattivato → escluso
    await ins('worker_documents', { company_id: cid, worker_id: wOff.id, doc_type: 'idoneita', name: 'Idoneità disattivo', file_path: `test/${T}/off.pdf`, expiry_date: d(-1) });

    // Notifiche: aiuto dalla timbratura (dentro, urgente), scadenza già coperta (fuori), avviso già letto (fuori)
    await ins('notifications', { company_id: cid, type: 'punch_help_request', severity: 'warning', title: `${T} Bruno ha bisogno di aiuto per timbrare`, body: 'GPS', entity_type: 'punch_help_request', entity_id: crypto.randomUUID(), read_by: [] });
    await ins('notifications', { company_id: cid, type: 'company_doc_expiry', severity: 'critical', title: 'DURC coperto altrove', entity_type: 'company_document', entity_id: crypto.randomUUID(), read_by: [] });
    await ins('notifications', { company_id: cid, type: 'weather_alert', severity: 'warning', title: 'Allerta già letta', entity_type: 'site', entity_id: sOpen.id, read_by: [userId] });

    // Meteo: una giornata da confermare (dentro), una già scartata (fuori), una su cantiere chiuso (fuori)
    await ins('site_weather_logs', { company_id: cid, site_id: sOpen.id, log_date: d(-2), precipitation_mm: 11, threshold_exceeded: true, threshold_reason: 'pioggia' });
    await ins('site_weather_logs', { company_id: cid, site_id: sOpen.id, log_date: d(-3), precipitation_mm: 9, threshold_exceeded: true, threshold_reason: 'pioggia', suspension_dismissed: true });
    await ins('site_weather_logs', { company_id: cid, site_id: sClosed.id, log_date: d(-2), precipitation_mm: 20, threshold_exceeded: true, threshold_reason: 'pioggia' });

    // Presenze di ieri: uscita automatica di Anna (dentro); Bruno uscita automatica
    // ma corretta a mano lo stesso giorno (fuori).
    const y = d(-1);
    const pl = (row) => ins('presence_logs', { company_id: cid, site_id: sOpen.id, ...row });
    await pl({ worker_id: wA.id, event_type: 'ENTRY', timestamp_server: `${y}T06:00:00Z`, method: 'worker_self_punch' });
    await pl({ worker_id: wA.id, event_type: 'EXIT', timestamp_server: `${y}T15:00:00Z`, method: 'ladia_action' });
    await pl({ worker_id: wB.id, event_type: 'ENTRY', timestamp_server: `${y}T06:00:00Z`, method: 'worker_self_punch' });
    await pl({ worker_id: wB.id, event_type: 'EXIT', timestamp_server: `${y}T15:00:00Z`, method: 'ladia_action' });
    await pl({ worker_id: wB.id, event_type: 'EXIT', timestamp_server: `${y}T14:30:00Z`, method: 'admin_manual_correction' });

    const r = await buildDaFare(cid, userId);
    const titles = r.items.map(i => `${i.bucket}|${i.title}`);
    const has = (re) => r.items.find(i => re.test(i.title));

    check('idoneità di Anna: una riga sola (campo e documento con la stessa data sono lo stesso fatto)',
      r.items.filter(i => /Idoneità medica — .*Anna/.test(i.title)).length === 1, titles);
    check('idoneità di Anna in "Questa settimana", link alla sua scheda Documenti',
      has(/Idoneità medica — .*Anna/)?.bucket === 'settimana' && has(/Idoneità medica — .*Anna/)?.link === `/lavoratori/${wA.id}/documenti`, has(/Idoneità medica — .*Anna/));
    check('formazione di Anna (solo campo, scaduta) in "Scaduto"', has(/Formazione sicurezza — .*Anna/)?.bucket === 'scaduto', titles);
    check('DURC rinnovato: nessuna riga DURC (né il documento vecchio né il campo con la stessa data)',
      !r.items.some(i => /DURC/.test(i.title)), titles);
    check('documento di Bruno "già prenotato" → sezione In corso, non tra le urgenze',
      r.items.find(i => i.id.startsWith('doc:') && /Bruno/.test(i.title))?.bucket === 'in_corso', titles);
    check('mezzo: revisione scaduta in "Scaduto" verso la scheda del mezzo; assicurazione lontana fuori',
      has(/Revisione periodica — Furgone/)?.bucket === 'scaduto' && has(/Revisione periodica — Furgone/)?.link === `/mezzi/${eq.id}/scheda` && !has(/Assicurazione — Furgone/), titles);
    check('riga "già prenotato" porta con sé la notifica per annullare lo snooze',
      !!r.items.find(i => i.id.startsWith('doc:') && /Bruno/.test(i.title))?.snoozeNotificationId, r.items.find(i => /Bruno/.test(i.title)));
    check('lavoratore disattivato: nessuna sua riga', !r.items.some(i => /Disattivo/.test(i.title)), titles);
    check('cantiere aperto con fine lavori superata → riga in "Scaduto" verso il cantiere',
      has(/Fine lavori — .*aperto/)?.bucket === 'scaduto' && has(/Fine lavori — .*aperto/)?.link === `/cantieri/${sOpen.id}/cantiere`, titles);
    check('cantiere chiuso: nessuna riga (né fine lavori né meteo)', !r.items.some(i => /chiuso/.test(i.title)), titles);
    check('pioggia da confermare: una sola riga (quella scartata non torna)',
      r.items.filter(i => i.kind === 'meteo').length === 1 && /11 mm di pioggia/.test(r.items.find(i => i.kind === 'meteo')?.subtitle || ''), r.items.filter(i => i.kind === 'meteo'));
    check('uscita automatica di ieri di Anna in lista, verso Persone → Presenze',
      r.items.some(i => i.kind === 'uscita' && /Anna/.test(i.title) && i.link === '/persone?tab=presenze'), titles);
    check('uscita automatica di Bruno già corretta a mano: fuori', !r.items.some(i => i.kind === 'uscita' && /Bruno/.test(i.title)), titles);
    check('richiesta di aiuto dalla timbratura: in cima, marcata urgente',
      r.items[0]?.type === 'punch_help_request' || (r.items.find(i => i.type === 'punch_help_request')?.urgent === true &&
        r.items.findIndex(i => i.type === 'punch_help_request') === r.items.findIndex(i => i.bucket === 'settimana')), titles);
    check('notifica di scadenza già coperta da un documento: non duplicata', !r.items.some(i => /coperto altrove/.test(i.title)), titles);
    check('avviso già letto da questo utente: fuori', !r.items.some(i => /già letta/.test(i.title)), titles);
    check('ordine: Scaduto prima di Questa settimana prima di In corso',
      r.items.map(i => ['scaduto', 'settimana', 'mese', 'in_corso'].indexOf(i.bucket)).every((v, i, a) => i === 0 || a[i - 1] <= v), titles);
    check('contatore campanella = scaduto + questa settimana', r.attention === r.counts.scaduto + r.counts.settimana, r.counts);

    // Subappaltatori: modulo congelato → anche un DURC subappaltatore scaduto non entra
    const { data: sub } = await supabase.from('subcontractors').insert({ company_id: cid, company_name: `${T} Sub`, durc_expiry: d(-2), is_active: true }).select().single();
    if (sub) {
      created.subs.push(sub.id);
      await supabase.from('subcontractor_documents').insert({ company_id: cid, subcontractor_id: sub.id, doc_type: 'durc', name: 'DURC sub', file_path: `test/${T}/sub.pdf`, expiry_date: d(-2) });
      const r2 = await buildDaFare(cid, userId);
      check('subappaltatori (modulo congelato): nessuna riga', !r2.items.some(i => /Sub|subappalt/i.test(i.title) || i.link.includes('/subappaltatori/')), r2.items.map(i => i.title));
    } else {
      fail('seminare un subappaltatore per il controllo del modulo congelato');
    }
  } finally {
    for (const t of ['notifications', 'site_weather_logs', 'worker_documents', 'company_documents', 'subcontractor_documents']) {
      await supabase.from(t).delete().eq('company_id', cid);
    }
    await supabase.from('documents').delete().eq('company_id', cid);
    // presence_logs è append-only (registro presenze): le righe di prova restano
    // legate all'azienda TEST-, come per gli altri selftest delle timbrature.
  }
  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
