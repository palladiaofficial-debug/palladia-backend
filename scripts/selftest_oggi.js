#!/usr/bin/env node
/**
 * scripts/selftest_oggi.js — F-364 (AUDIT.md del frontend): Palladia semplice, la home «Oggi».
 *
 * 1. Puri (lib/oggi.js::componi) sulle voci vere di MSC del 17/10 (54 in Da fare):
 *    diventano 7 righe in ordine di importanza, frasi semplici, importi col punto;
 *    una richiesta d'aiuto di un mese fa NON va in cima; nessuna voce → «Tutto a posto».
 * 2. Rotta vera contro il DB: flag spento → 404; acceso → il conto del sub in attesa
 *    è una riga, l'operaio del sub entrato oggi è contato; un tecnico non vede i soldi.
 */
'use strict';
require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');

const jwtPath = path.join(__dirname, '../middleware/verifyJwt.js');
require.cache[jwtPath] = { id: jwtPath, filename: jwtPath, loaded: true, exports: {
  verifySupabaseJwt: (req, _res, next) => { req.companyId = req.get('x-test-company'); req.userRole = req.get('x-test-role') || 'owner'; req.user = { id: null }; next(); },
} };

const supabase = require('../lib/supabase');
const { componi } = require('../lib/oggi');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

// Le voci di Da fare di MSC del 17/10/2026, ridotte ai campi che contano
function vociMsc() {
  const v = [];
  const pag = (nome, importo, days, soll) => v.push({ id: `pagamento:${nome}${days}`, kind: 'pagamento', type: 'pagamento', title: nome, nome, chiave: nome.toLowerCase(), importo, days, sollecitato: soll, bucket: days < 0 ? 'scaduto' : 'settimana' });
  pag('Guardalà Giuseppina', 1200, -33, true); pag('WC Loc Italia', 524.47, -17, true); pag('Stelli Impianti', 3000, -2, true); pag('Stelli Impianti', 3000, -2, true);
  for (const s of ['Piazzetta degli Orti di Banchi 3', 'Corso Ugo Bassi 28', 'Corso Sardegna 88', 'Via Riboli 4b', 'Via Fereggiano 175', 'Via Toselli 9']) {
    v.push({ id: `site:${s}:fine`, kind: 'scadenza', type: 'fine_cantiere', title: `Fine lavori — ${s}`, subtitle: 'data di fine superata', bucket: 'scaduto', days: -10, link: '/cantieri/x' });
  }
  v.push({ id: 'doc:1', kind: 'scadenza', type: 'assicurazione', title: 'Assicurazione — Autocarro NISSAN', subtitle: 'scaduto da 63 giorni · 15 ago', bucket: 'scaduto', days: -63 });
  v.push({ id: 'doc:2', kind: 'scadenza', type: 'documento', title: 'Visite mediche', subtitle: 'scaduto da 30 giorni · 17 set', bucket: 'scaduto', days: -30 });
  v.push({ id: 'doc:3', kind: 'scadenza', type: 'documento', title: 'Aggiornamento RSPP — CATALANO ARIANNA', subtitle: 'scaduto da 17 giorni · 30 set', bucket: 'scaduto', days: -17 });
  v.push({ id: 'company:durc', kind: 'scadenza', type: 'durc', title: 'DURC', subtitle: 'scaduto da 7 giorni · 10 ott', bucket: 'scaduto', days: -7 });
  v.push({ id: 'fix:1', kind: 'timbratura', type: 'missing_exit', title: 'Petriccione Raffaele · uscita mancante', subtitle: '12 ott: entrata 07:44, nessuna uscita', bucket: 'settimana', days: -5, urgent: true });
  v.push({ id: 'fix:2', kind: 'timbratura', type: 'missing_exit', title: 'Petriccione Raffaele · uscita mancante', subtitle: '13 ott: entrata 07:30, nessuna uscita', bucket: 'settimana', days: -4, urgent: true });
  v.push({ id: 'notif:aiuto', kind: 'avviso', type: 'punch_help_request', title: 'Carlos Sanchez Ganay ha bisogno di aiuto per timbrare', subtitle: 'Cantiere: Corso Sardegna 88. Registra tu la sua timbratura da Presenze', date: '2026-09-15', bucket: 'settimana', days: 0, urgent: true, link: '/persone?tab=presenze' });
  const cantieriPioggia = ['Corso Sardegna 95', 'Corso Ugo Bassi 28', 'Magazzino MSCedilizia', 'Piazzetta degli Orti di Banchi 3', 'Via Balbi 31', 'Via Riboli 4b', 'Via San Nazaro 34', 'Via Toselli 9', 'Corso Sardegna 88'];
  for (let i = 0; i < 33; i++) v.push({ id: `weather:${i}`, kind: 'meteo', type: 'pioggia', title: `Conferma sospensione — ${cantieriPioggia[i % 9]}`, date: i === 0 ? '2026-09-17' : '2026-10-08', bucket: 'settimana', days: -10 });
  for (const t of ['Patente — Rossi', 'DURC — Edil Srl', 'Visita medica — Bianchi', 'Corso ponteggi — Verdi']) v.push({ id: `doc:p${t}`, kind: 'scadenza', type: 'documento', title: t, subtitle: 'scade tra 3 giorni · 20 ott', bucket: 'settimana', days: 3 });
  for (let i = 0; i < 8; i++) v.push({ id: `notif:m${i}`, kind: 'avviso', type: 'weather_alert', title: 'Allerta meteo', bucket: 'mese', days: 0 });
  return v;
}

function puri() {
  console.log('\n\x1b[1mF-364 — la home sulle voci vere di MSC\x1b[0m');
  const items = vociMsc();
  check('le voci di partenza sono 54 come in Da fare (scaduto + settimana)', items.filter(i => ['scaduto', 'settimana'].includes(i.bucket)).length === 54, items.length);
  const h = componi({ items, conti: [], presenze: { dentro: 13, cantieri: 4 }, vedeSoldi: true, oggi: '2026-10-17' });
  const tutte = [h.prima, ...h.poi];
  check('54 voci → «Oggi 7 cose da fare»', h.titolo === 'Oggi 7 cose da fare', h.titolo);
  check('il numerino del menu è 7 come la home, non 54', h.quante === 7, h.quante);
  check('in cima le fatture scadute (la richiesta d\'aiuto del 15/09 non è urgente)', h.prima.id === 'pagamenti' && h.prima.titolo === '4 fatture scadute da pagare', h.prima);
  check('importo col punto delle migliaia e i fornitori in breve', h.prima.sotto === '7.724,47 €, Guardalà Giuseppina e altri 2. Tutti ti hanno sollecitato', h.prima.sotto);
  check('poi: documenti scaduti, timbrature, pioggia (ordine di importanza)', JSON.stringify(h.poi.map(r => r.id)) === JSON.stringify(['documenti-scaduti', 'timbrature', 'pioggia']), h.poi.map(r => r.id));
  check('4 documenti scaduti, le 6 fine lavori a parte', h.poi[0].titolo === '4 documenti scaduti' && h.poi[0].sotto === 'Assicurazione, Visite mediche e altri 2', h.poi[0]);
  check('una persona con 2 uscite mancanti: una riga sola col suo nome', h.poi[1].titolo === 'Petriccione Raffaele: 2 timbrature da sistemare', h.poi[1].titolo);
  check('33 giornate di pioggia in una riga', h.poi[2].titolo === '33 giornate di pioggia da confermare' && h.poi[2].sotto === 'In 9 cantieri, dal 17 settembre', h.poi[2]);
  check('le altre 3 restano contate («e altre 3»)', h.altre === 3, h.altre);
  check('ogni riga ha frase, spiegazione, tasto e link', tutte.every(r => r.titolo && r.sotto && r.tasto && r.link?.startsWith('/')), tutte);
  check('soldi: entro 7 giorni, scadute comprese', h.soldi.totaleTesto === '7.724,47 €' && h.soldi.sotto === 'di cui 4 scadute', h.soldi);
  check('cantiere: chi è dentro adesso passa così com\'è', h.cantiere.dentro === 13, h.cantiere);
  check('nessuna riga parla di cose «del mese» (allerte meteo in bucket mese)', !JSON.stringify(h).includes('Allerta meteo'));

  // La stessa richiesta d'aiuto, ma di oggi: allora sì, in cima
  const oggi = items.map(i => (i.id === 'notif:aiuto' ? { ...i, date: '2026-10-17' } : i));
  const h2 = componi({ items: oggi, vedeSoldi: true, oggi: '2026-10-17' });
  const vecchia = componi({ items: [{ ...items.find(i => i.id === 'notif:aiuto'), date: '2026-09-11' }], oggi: '2026-10-17' });
  check('richiesta d\'aiuto vecchia: «Dell\'11 settembre: guarda se è ancora da fare»', vecchia.prima.sotto === 'Dell\'11 settembre: guarda se è ancora da fare' && vecchia.prima.tasto === 'Apri', vecchia.prima);
  check('richiesta d\'aiuto di oggi → prima cosa, con il cantiere', h2.prima.id === 'notif:aiuto' && h2.prima.sotto === 'Corso Sardegna 88. Registra tu la sua timbratura' && h2.prima.tasto === 'Aiutalo a timbrare', h2.prima);

  // Conto del sub in attesa: davanti ai documenti, dopo le fatture scadute
  const h3 = componi({ items, conti: [{ id: 'c1', impresa: 'Ayat', meseTesto: 'settembre 2026', chiesto: 4592 }], vedeSoldi: true, oggi: '2026-10-17' });
  check('il conto di Ayat subito dopo le fatture scadute', h3.poi[0].titolo === 'Il conto di Ayat aspetta il tuo ok' && h3.poi[0].sotto === 'Settembre 2026, 4.592 €. Senza il tuo ok non può fare la fattura', h3.poi[0]);

  // Una sola voce per gruppo: frase sulla voce, non sul gruppo
  const h4 = componi({ items: [
    { id: 'exit:1', kind: 'uscita', title: 'Uscita non timbrata — Marco Neri', subtitle: 'ieri, Via Roma · chiusa in automatico, controlla l\'orario', bucket: 'settimana', days: -1 },
    { id: 'sub:1:durc', kind: 'scadenza', type: 'durc', title: 'DURC — Ayat', subtitle: 'scade tra 9 giorni · 26 ott', bucket: 'mese', days: 9 },
    { id: 'pagamento:1', kind: 'pagamento', title: 'Edilmarket', nome: 'Edilmarket', importo: 12480, days: 4, bucket: 'settimana' },
  ], vedeSoldi: true, oggi: '2026-10-17' });
  check('un\'uscita sola: «Marco Neri non ha timbrato l\'uscita»', h4.prima.titolo === 'Marco Neri non ha timbrato l\'uscita' && h4.prima.sotto === 'Ieri, Via Roma. Scrivi a che ora è uscito', h4.prima);
  check('una fattura non scaduta e non sollecitata NON è una cosa da fare (sta in Soldi)', h4.poi.length === 0 && h4.soldi.totaleTesto === '12.480 €' && h4.soldi.sotto === 'entro 7 giorni', h4);
  check('«Oggi 1 cosa da fare» al singolare', h4.titolo === 'Oggi 1 cosa da fare', h4.titolo);

  const vuota = componi({ items: [], vedeSoldi: false, oggi: '2026-10-17' });
  check('niente da fare → «Tutto a posto», nessuna prima cosa', vuota.titolo === 'Tutto a posto' && vuota.prima === null && vuota.poi.length === 0, vuota);
  check('chi non vede i pagamenti non ha il riquadro Soldi', vuota.soldi === null);
}

async function rotta() {
  console.log('\n\x1b[1mF-364 — GET /api/v1/oggi contro il DB\x1b[0m');
  const app = express();
  app.use('/api/v1', require('../routes/v1/oggi'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const get = (company, role = 'owner') => fetch(`${base}/oggi`, { headers: { 'x-test-company': company, 'x-test-role': role } });
  const A = await ins('companies', { name: `TEST-F364-${Date.now()}` });
  try {
    check('flag spento → 404', (await get(A.id)).status === 404);
    for (const feature of ['home_semplice', 'conti_sub', 'da_pagare']) await ins('company_feature_flags', { company_id: A.id, feature, enabled: true });
    const vuota = await (await get(A.id)).json();
    check('azienda nuova: «Tutto a posto», 0 dentro', vuota.titolo === 'Tutto a posto' && vuota.cantiere?.dentro === 0 && vuota.prima === null, vuota);
    check('il titolare vede il riquadro Soldi (0 €)', vuota.soldi?.totaleTesto === '0 €', vuota.soldi);

    const site = await ins('sites', { company_id: A.id, name: 'TEST Via Roma', address: 'Via Roma 1, Genova', status: 'attivo' });
    const sub = await ins('subcontractors', { company_id: A.id, company_name: 'AYAT SRLS' });
    const op = await ins('sub_workers', { company_id: A.id, subcontractor_id: sub.id, full_name: 'Ion Popescu', added_via: 'ufficio' });
    await ins('sub_presenze', { company_id: A.id, site_id: site.id, subcontractor_id: sub.id, sub_worker_id: op.id, event: 'entrata', source: 'ufficio' });
    await ins('sub_conti', { company_id: A.id, subcontractor_id: sub.id, impresa_nome: 'AYAT SRLS', impresa_chiave: 'ayat', site_id: site.id, mese: '2026-09-01', stato: 'da_controllare', totale_scritto: 4592 });
    const h = await (await get(A.id)).json();
    check('il conto in attesa è la prima cosa, col nome corto', h.prima?.titolo === 'Il conto di Ayat aspetta il tuo ok' && h.prima?.link === '/scadenze?type=conti', h.prima);
    check('l\'operaio del sub entrato oggi è contato', h.cantiere?.dentro === 1 && h.cantiere?.cantieri === 1, h.cantiere);
    const tec = await (await get(A.id, 'tech')).json();
    check('anche il tecnico vede il conto (controlla lui)', tec.prima?.titolo === 'Il conto di Ayat aspetta il tuo ok', tec.prima);
    // F-366: il riquadro di Ladia = la home in piccolo (stesse righe, stesso numero)
    const { buildDailyBrief } = require('../lib/dailyBrief');
    const brief = await buildDailyBrief(A.id, null);
    check('Ladia: «Da fare» = il numerino della home', brief.semplice === true && brief.kpi.da_fare === h.quante, { kpi: brief.kpi, quante: h.quante });
    check('Ladia: le righe sono quelle della home, senza tasti dalla riga', brief.alerts.length === h.quante && brief.alerts[0].title === h.prima.titolo && brief.alerts.every(a => a.action === null), brief.alerts);
    check('Ladia: senza menu a 4 voci il conto apre Da fare', brief.alerts[0].link === '/scadenze?type=conti', brief.alerts[0].link);
    await ins('company_feature_flags', { company_id: A.id, feature: 'menu_semplice', enabled: true });
    const brief2 = await buildDailyBrief(A.id, null);
    check('Ladia: col menu a 4 voci il conto apre Soldi', brief2.alerts[0].link === '/soldi?vista=conti', brief2.alerts[0].link);
    await supabase.from('company_feature_flags').delete().eq('company_id', A.id).in('feature', ['home_semplice', 'menu_semplice']);
    const vecchio = await buildDailyBrief(A.id, null);
    check('Ladia: flag spenti → il riquadro di prima (conteggio di Da fare)', !vecchio.semplice && typeof vecchio.kpi.da_fare === 'number', vecchio);
    for (const feature of ['home_semplice']) await ins('company_feature_flags', { company_id: A.id, feature, enabled: true });
    const cs = await (await get(A.id, 'capocantiere')).json();
    check('un capocantiere non vede conti né soldi', cs.prima === null && cs.soldi === null, cs);
  } finally {
    server.close();
    for (const t of ['sub_conti', 'sub_presenze', 'sub_workers', 'company_feature_flags', 'subcontractors', 'sites']) await supabase.from(t).delete().eq('company_id', A.id);
    await supabase.from('companies').delete().eq('id', A.id);
  }
}

(async () => {
  puri();
  await rotta();
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
