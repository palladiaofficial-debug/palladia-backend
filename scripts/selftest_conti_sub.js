#!/usr/bin/env node
/**
 * scripts/selftest_conti_sub.js — F-360 (AUDIT.md del frontend): Conti dei sub.
 *
 * 1. Controlli puri (lib/contiSubControllo.js): nomi del foglio ↔ persone
 *    registrate, ore dagli ingressi (pausa, uscita mancante, mezz'ora), le
 *    differenze, decisioni e totali, giornate e mezze giornate, fatture abbinate.
 * 2. Lettura (lib/contiSubLettura.js) senza IA: verifica della risposta, Excel → testo.
 * 3. Rotte vere contro il DB (IA sostituita da una lettura finta):
 *    settembre con ingressi veri → 2 differenze → approva → prezzi imparati;
 *    ottobre senza ingressi → tariffa e prezzo cambiati, quantità oltre il contratto;
 *    PDF ed Excel; fatture in Da pagare abbinate; un'altra azienda non vede niente.
 */
'use strict';
require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const ExcelJS = require('exceljs');

const jwtPath = path.join(__dirname, '../middleware/verifyJwt.js');
require.cache[jwtPath] = { id: jwtPath, filename: jwtPath, loaded: true, exports: {
  verifySupabaseJwt: (req, _res, next) => { req.companyId = req.get('x-test-company'); req.userRole = req.get('x-test-role') || 'owner'; req.user = { id: null, email: 'tecnico@example.com', user_metadata: { full_name: 'Tecnico Prova' } }; next(); },
} };
// La lettura vera chiama l'IA: qui una lettura finta scelta dal nome del file
const letturaPath = path.join(__dirname, '../lib/contiSubLettura.js');
const veraLettura = require(letturaPath);
const LETTURE = {};
require.cache[letturaPath].exports = { ...veraLettura, leggiFoglio: async ({ originalname }) => (LETTURE[originalname] ? JSON.parse(JSON.stringify(LETTURE[originalname])) : null) };

const supabase = require('../lib/supabase');
const C = require('../lib/contiSubControllo');
const S = require('../lib/contiSub');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 700)}`); failed++; }
}
const T = `TEST-F360-${Date.now()}`;
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

function puri() {
  console.log('\n\x1b[1mF-360 — controlli\x1b[0m');
  const persone = [{ id: 'm', full_name: 'BENALI MOHAMED' }, { id: 'a', full_name: 'Rossi Ali' }, { id: 'k', full_name: 'Karim Ahmed' }, { id: 'm2', full_name: 'Mohamed Saidi' }];
  check('«Benali M.» → Benali Mohamed', C.abbinaPersona('Benali M.', persone)?.id === 'm');
  check('«Mohamed B.» → Benali Mohamed (iniziale del cognome)', C.abbinaPersona('Mohamed B.', persone)?.id === 'm');
  check('«Mohamed» da solo: due persone, nessuna scelta', C.abbinaPersona('Mohamed', persone) === null);
  check('«Alì Rossi» con l\'accento → Rossi Ali', C.abbinaPersona('Alì Rossi', persone)?.id === 'a');
  check('solo iniziali: nessuna scelta', C.abbinaPersona('M. B.', persone) === null);
  check('nome che non c\'è: nessuna scelta', C.abbinaPersona('Giuseppe Verdi', persone) === null);

  const orario = { fine: 17 * 60, pausaDa: 12 * 60, pausaA: 13 * 60 };
  const ing = C.oreDaPresenze([
    { sub_worker_id: 'm', event: 'entrata', giorno: '2026-09-02', min: 7 * 60 + 58 },
    { sub_worker_id: 'm', event: 'uscita', giorno: '2026-09-02', min: 17 * 60 + 2 },
    { sub_worker_id: 'a', event: 'entrata', giorno: '2026-09-21', min: 13 * 60 + 10 },
    { sub_worker_id: 'a', event: 'uscita', giorno: '2026-09-21', min: 17 * 60 },
    { sub_worker_id: 'k', event: 'entrata', giorno: '2026-09-03', min: 8 * 60 },
  ], orario);
  check('7:58–17:02 con la pausa 12–13 → 8 ore', ing.get('m').get('2026-09-02').ore === 8, [...ing.get('m')]);
  check('13:10–17:00 → 4 ore (3h50 alla mezz\'ora)', ing.get('a').get('2026-09-21').ore === 4);
  check('entrata senza uscita: fino alla fine dell\'orario, «stimata»', ing.get('k').get('2026-09-03').ore === 8 && ing.get('k').get('2026-09-03').stimata === true);

  const ris = C.controlla({
    ore: [
      { persona: 'Mohamed B.', giorno: '2026-09-02', ore_foglio: 8 },
      { persona: 'Mohamed B.', giorno: '2026-09-14', ore_foglio: 8 },
      { persona: 'Rossi Ali', giorno: '2026-09-21', ore_foglio: 8 },
      { persona: 'Karim', giorno: '2026-09-03', ore_foglio: 7.5 },
    ],
    misura: [
      { voce: 'Rasatura pareti', unita: 'm²', quantita_foglio: 420, prezzo_foglio: 9, importo_scritto: 3780 },
      { voce: 'Posa cartongesso (mq)', unita: 'm²', quantita_foglio: 85, prezzo_foglio: null, importo_scritto: 1870 },
      { voce: 'Coloritura', unita: 'm²', quantita_foglio: 260, prezzo_foglio: 6, importo_scritto: 1500 },
      { voce: 'Assistenza', unita: 'a corpo', quantita_foglio: 1, prezzo_foglio: null, importo_scritto: null },
    ],
    tariffaFoglio: 30, tariffaNota: 28, ingressi: ing, persone,
    prezzi: new Map([['rasatura pareti', { prezzo: 8.5, contratto: 1200 }], ['posa cartongesso', { prezzo: 22, contratto: 300 }]]),
    giaApprovato: new Map([['posa cartongesso', 240]]),
  });
  const [o1, o2, o3, o4] = ris.righeOre;
  check('ore uguali agli ingressi: nessun problema', o1.problema === null && o1.ore_ingressi === 8);
  check('nel foglio ma mai entrato: «non_entrato», proposta 0', o2.problema === 'non_entrato' && o2.proposta === 0);
  check('8 nel foglio, 4 dagli ingressi: «ore_diverse», proposta 4', o3.problema === 'ore_diverse' && o3.proposta === 4);
  check('meno ore nel foglio che in cantiere: va bene così', o4.problema === null);
  check('tariffa 30 nel foglio, 28 approvata: da guardare', ris.tariffa.problema === 'prezzo_diverso' && ris.tariffa.proposta === 28);
  const [m1, m2, m3, m4] = ris.righeMisura;
  check('prezzo cambiato (9 contro 8,50): «prezzo_diverso»', m1.problema === 'prezzo_diverso' && m1.proposta === 8.5);
  check('voce scritta in un altro modo «(mq)» riconosciuta; prezzo dall\'importo; 240+85 su 300 → «oltre_contratto», proposta 60', m2.voce_chiave === 'posa cartongesso' && m2.prezzo_foglio === 22 && m2.problema === 'oltre_contratto' && m2.proposta === 60, m2);
  check('importo scritto sbagliato (260 × 6 ≠ 1.500): segnato', m3.problema === null && m3.importo_sbagliato === true);
  check('senza prezzo né importo e mai approvata: «prezzo_mancante»', m4.problema === 'prezzo_mancante');

  const senza = C.controlla({ ore: [{ persona: 'Chiunque', giorno: '2026-10-01', ore_foglio: 8 }], ingressi: null, tariffaFoglio: 28 });
  check('nessun ingresso nel mese: le ore non si confrontano', senza.senzaIngressi === true && senza.righeOre[0].problema === null);
  const squadra = C.controlla({ ore: [{ persona: 'Squadra', giorno: null, ore_foglio: 30 }], ingressi: ing, persone, tariffaFoglio: 28 });
  check('solo il totale della squadra: confronto con tutti gli ingressi (20 ore)', squadra.righeOre[0].ore_ingressi === 20 && squadra.righeOre[0].problema === 'ore_diverse');

  // Decisioni e totali
  const conto = { tariffa_foglio: 30, tariffa_nota: 28, tariffa: null, tariffa_decisione: null };
  const righe = [
    { tipo: 'ore', ore_foglio: 8, problema: null },
    { tipo: 'ore', ore_foglio: 8, problema: 'non_entrato', proposta: 0, decisione: null },
    { tipo: 'misura', quantita_foglio: 420, prezzo_foglio: 9, problema: 'prezzo_diverso', proposta: 8.5, decisione: null },
  ];
  check('3 cose aperte (tariffa, ore, prezzo)', C.totali(conto, righe).aperte === 3);
  righe[1].decisione = 'proposta'; righe[2].decisione = 'proposta';
  const t = C.totali({ ...conto, tariffa_decisione: 'proposta', tariffa: 28 }, righe);
  check('decise: 8 ore × 28 + 420 × 8,50 = 3.794 €', t.aperte === 0 && t.ore === 8 && t.totale === 3794, t);
  righe[1].decisione = 'foglio';
  check('«La riconosco»: 16 ore', C.totali({ ...conto, tariffa_decisione: 'foglio' }, righe).ore === 16);
  check('giornate: 332 ore = «41½ giornate»', C.giornateTesto(332) === '41½ giornate');
  check('4 ore = «½ giornata», 8 = «1 giornata», 336 = «42 giornate»', C.giornateTesto(4) === '½ giornata' && C.giornateTesto(8) === '1 giornata' && C.giornateTesto(336) === '42 giornate');

  const ab = C.abbinaFatture(
    [{ id: 'set', mese: '2026-09-01', totale_approvato: 8008, approvato_at: '2026-10-02' }, { id: 'ott', mese: '2026-10-01', totale_approvato: 6028, approvato_at: '2026-11-02' }],
    [{ id: 'f2', amount: 6328, created_at: '2026-11-05' }, { id: 'f1', amount: 8008, created_at: '2026-10-05' }],
  );
  check('fatture: importo uguale → stesso conto, differenza 0', ab.get('f1')?.contoId === 'set' && ab.get('f1').differenza === 0);
  check('fatture: l\'altra al conto rimasto, 300 € in più', ab.get('f2')?.contoId === 'ott' && ab.get('f2').differenza === 300);
  check('mese precedente: a gennaio è dicembre dell\'anno prima', S.mesePrecedente('2027-01-15') === '2026-12' && S.mesePrecedente('2026-10-17') === '2026-09');
}

async function lettura() {
  console.log('\n\x1b[1mF-360 — lettura del foglio\x1b[0m');
  const L = veraLettura.controllaLettura;
  check('non leggibile → null', L({ leggibile: false }) === null);
  const r = L({
    leggibile: true, impresa: ' AYAT  S.R.L.S. ', cantiere: 'Via Riboli 4b', mese: '2026-09', tariffa_oraria: '28,00',
    ore: [{ persona: 'Benali M.', giorno: '2026-09-02', ore: '8' }, { persona: 'Rossi', giorno: '02/09', ore: '4,5' }, { persona: 'X', giorno: '', ore: '8' }, { persona: 'Zero', giorno: '2026-09-03', ore: '0' }],
    lavori: [{ voce: 'Rasatura', unita: 'm²', quantita: '420', prezzo: '8,50', importo: '3.570,00' }, { voce: 'Pulizia finale', unita: '', quantita: '', prezzo: '', importo: '350' }],
    totale_scritto: '€ 16.632,00',
  });
  check('impresa e tariffa pulite («28,00» → 28)', r.impresa === 'AYAT S.R.L.S.' && r.tariffa === 28 && r.mese === '2026-09');
  check('ore: data non ISO → senza giorno; nomi di 1 lettera e zero ore scartati', r.ore.length === 2 && r.ore[1].giorno === null && r.ore[1].ore_foglio === 4.5, r.ore);
  check('«3.570,00» → 3570; lavoro a corpo senza quantità → 1 × 350', r.misura[0].importo_scritto === 3570 && r.misura[1].quantita_foglio === 1 && r.misura[1].prezzo_foglio === 350 && r.misura[1].unita === 'a corpo', r.misura);
  check('totale scritto «€ 16.632,00» → 16632', r.totaleScritto === 16632);
  check('niente ore né lavori → null', L({ leggibile: true, impresa: 'X srl', ore: [], lavori: [] }) === null);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Ottobre');
  ws.addRow(['Operaio', '1', '2', 'Totale']);
  ws.addRow(['Benali Mohamed', 8, 4]);
  ws.getCell('D2').value = { formula: 'SUM(B2:C2)', result: 12 };
  wb.addWorksheet('Nascosta', { state: 'hidden' }).addRow(['segreto']);
  const testo = await veraLettura.excelInTesto(Buffer.from(await wb.xlsx.writeBuffer()));
  check('Excel → testo: celle, risultato delle formule, schede nascoste saltate', /Scheda «Ottobre»/.test(testo) && /Benali Mohamed \| 8 \| 4 \| 12/.test(testo) && !/segreto/.test(testo), testo);
  check('tipo del file: .xls vecchio riconosciuto, .docx no', veraLettura.tipoFoglio('a.XLS') === 'xls' && veraLettura.tipoFoglio('a.xlsx') === 'excel' && veraLettura.tipoFoglio('a.docx', 'application/msword') === null);
}

async function rotte() {
  console.log('\n\x1b[1mF-360 — rotte e DB\x1b[0m');
  const app = express(); app.use(express.json());
  app.use('/api/v1', require('../routes/v1/contiSub'));
  app.use('/api/v1', require('../routes/v1/daPagare'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, url, { body, company, role, form, raw } = {}) => {
    const headers = { 'x-test-company': company };
    if (role) headers['x-test-role'] = role;
    let payload;
    if (form) payload = form;
    else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(`${base}${url}`, { method, headers, body: payload });
    if (raw) return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()), disp: r.headers.get('content-disposition') };
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const carica = (company, nome) => {
    const f = new FormData();
    f.append('file', new Blob([Buffer.from('foglio finto')], { type: nome.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), nome);
    return call('POST', '/conti-sub', { company, form: f });
  };

  const A = await ins('companies', { name: `${T}-A` });
  const B = await ins('companies', { name: `${T}-B` });
  try {
    check('modulo spento: 404', (await call('GET', '/conti-sub', { company: A.id })).status === 404);
    for (const c of [A, B]) for (const feature of ['conti_sub', 'da_pagare']) await ins('company_feature_flags', { company_id: c.id, feature, enabled: true });
    check('sola lettura: 403', (await call('GET', '/conti-sub', { company: A.id, role: 'viewer' })).status === 403);

    const site = await ins('sites', { company_id: A.id, name: `${T}-Riboli`, address: 'Via Riboli 4b', status: 'attivo' });
    await ins('sites', { company_id: A.id, name: `${T}-Corso Europa`, address: 'Corso Europa 220', status: 'attivo' });
    const sub = await ins('subcontractors', { company_id: A.id, company_name: `${T} AYAT SRLS` });
    await ins('site_subcontractors', { company_id: A.id, site_id: site.id, subcontractor_id: sub.id });
    const w = {};
    for (const [k, n] of [['m', 'BENALI MOHAMED'], ['a', 'Rossi Ali'], ['k', 'Karim Ahmed']]) w[k] = await ins('sub_workers', { company_id: A.id, subcontractor_id: sub.id, full_name: n, added_via: 'ufficio' });
    // Settembre (ora legale, Roma = UTC+2): 08:00 = 06:00Z
    const pres = (k, giorno, ev, hhmm) => ({ company_id: A.id, site_id: site.id, subcontractor_id: sub.id, sub_worker_id: w[k].id, event: ev, source: 'ufficio', at: new Date(`${giorno}T${hhmm}:00+02:00`).toISOString() });
    const { error: pe } = await supabase.from('sub_presenze').insert([
      pres('m', '2026-09-02', 'entrata', '08:00'), pres('m', '2026-09-02', 'uscita', '17:00'),
      pres('m', '2026-09-03', 'entrata', '07:55'), pres('m', '2026-09-03', 'uscita', '17:05'),
      pres('a', '2026-09-02', 'entrata', '08:00'), pres('a', '2026-09-02', 'uscita', '17:00'),
      pres('a', '2026-09-21', 'entrata', '13:10'), pres('a', '2026-09-21', 'uscita', '17:00'),
      pres('k', '2026-09-03', 'entrata', '08:00'), pres('k', '2026-09-03', 'uscita', '17:00'),
    ]);
    if (pe) throw new Error(pe.message);

    LETTURE['AYAT_settembre.xlsx'] = {
      impresa: 'AYAT S.R.L.S.', cantiere: 'cantiere Riboli', mese: '2026-09', tariffa: 28, totaleScritto: 16000,
      ore: [
        { persona: 'Mohamed B.', giorno: '2026-09-02', ore_foglio: 8 }, { persona: 'Mohamed B.', giorno: '2026-09-03', ore_foglio: 8 },
        { persona: 'Mohamed B.', giorno: '2026-09-14', ore_foglio: 8 }, { persona: 'Ali Rossi', giorno: '2026-09-02', ore_foglio: 8 },
        { persona: 'Ali Rossi', giorno: '2026-09-21', ore_foglio: 8 }, { persona: 'Karim', giorno: '2026-09-03', ore_foglio: 8 },
      ],
      misura: [
        { voce: 'Rasatura pareti', unita: 'm²', quantita_foglio: 420, prezzo_foglio: 8.5, importo_scritto: 3570 },
        { voce: 'Coloritura due mani', unita: 'm²', quantita_foglio: 260, prezzo_foglio: 6, importo_scritto: 1560 },
        { voce: 'Posa cartongesso', unita: 'm²', quantita_foglio: 85, prezzo_foglio: 22, importo_scritto: 1870 },
      ],
    };
    let r = await carica(A.id, 'AYAT_settembre.xlsx');
    let d = r.body;
    check('carica: impresa e cantiere riconosciuti, mese dal foglio', r.status === 201 && d.impresa.id === sub.id && d.cantiere?.id === site.id && d.mese === '2026-09', d);
    check('carica: 2 differenze sulle ore (14/9 Mohamed mai entrato, 21/9 Ali 4 ore)', d.totali.aperte === 2
      && d.ore.find(x => x.giorno === '2026-09-14').problema === 'non_entrato'
      && d.ore.find(x => x.giorno === '2026-09-21').problema === 'ore_diverse' && d.ore.find(x => x.giorno === '2026-09-21').proposta === 4, d.ore);
    check('carica: le altre 4 giornate combaciano; primo conto, prezzi senza confronto', d.totali.oreOk === 4 && d.misura.every(x => !x.problema) && !d.tariffa.problema);
    check('carica: somma del foglio sbagliata segnalata (16.000 scritto, righe 1.344 + 7.000)', d.totali.sommaSbagliata === true && d.totali.sommaFoglio === 8344 && d.totali.chiesto === 16000, d.totali);
    check('la frase per il tecnico: «nessun ingresso in cantiere quel giorno», tasti con i verbi', /nessun ingresso in cantiere quel giorno/.test(d.ore.find(x => x.giorno === '2026-09-14').testo.dettaglio) && d.ore.find(x => x.giorno === '2026-09-21').testo.proposta === 'Conto 4 ore');
    check('approva con differenze aperte: 409', (await call('POST', `/conti-sub/${d.id}/approva`, { company: A.id })).body.error === 'DA_GUARDARE');
    check('un\'altra azienda: il conto non esiste', (await call('GET', `/conti-sub/${d.id}`, { company: B.id })).status === 404);

    const r14 = d.ore.find(x => x.giorno === '2026-09-14'), r21 = d.ore.find(x => x.giorno === '2026-09-21');
    check('decisione non valida: 400', (await call('POST', `/conti-sub/${d.id}/decidi`, { company: A.id, body: { riga: r14.id, decisione: 'boh' } })).status === 400);
    await call('POST', `/conti-sub/${d.id}/decidi`, { company: A.id, body: { riga: r14.id, decisione: 'proposta' } });
    d = (await call('POST', `/conti-sub/${d.id}/decidi`, { company: A.id, body: { riga: r21.id, decisione: 'proposta' } })).body;
    check('decise: 36 ore (4½ giornate) × 28 + 7.000 = 8.008 €', d.totali.aperte === 0 && d.totali.ore === 36 && d.totali.giornateTesto === '4½ giornate' && d.totali.totale === 8008, d.totali);
    d = (await call('POST', `/conti-sub/${d.id}/approva`, { company: A.id })).body;
    check('approvato: stato, totale, chi', d.stato === 'approvato' && d.approvato.totale === 8008 && d.approvato.da === 'Tecnico Prova', d.approvato);
    const contoSet = d;
    const { data: prezzi } = await supabase.from('sub_prezzi').select('voce_chiave, prezzo, site_id').eq('company_id', A.id);
    check('prezzi imparati dal conto approvato (tariffa 28, rasatura 8,50), per cantiere e generali', prezzi.filter(p => p.voce_chiave === '__ore' && Number(p.prezzo) === 28).length === 2 && prezzi.some(p => p.voce_chiave === 'rasatura pareti' && Number(p.prezzo) === 8.5 && p.site_id === site.id), prezzi);
    check('stesso mese di nuovo, già approvato: 409', (await carica(A.id, 'AYAT_settembre.xlsx')).body.error === 'GIA_APPROVATO');
    check('approvato non si elimina: 409', (await call('DELETE', `/conti-sub/${d.id}`, { company: A.id })).status === 409);

    // PDF ed Excel
    const pdf = await call('GET', `/conti-sub/${d.id}/pdf`, { company: A.id, raw: true });
    check('PDF del conto approvato', pdf.status === 200 && pdf.type === 'application/pdf' && pdf.buf.slice(0, 4).toString() === '%PDF' && /Conto%20/.test(pdf.disp || ''), { status: pdf.status, type: pdf.type });
    const xl = await call('GET', `/conti-sub/${d.id}/excel`, { company: A.id, raw: true });
    const wb = new ExcelJS.Workbook();
    if (xl.status === 200) await wb.xlsx.load(xl.buf);
    const celle = [];
    wb.worksheets[0]?.eachRow(row => celle.push(row.values.join('|')));
    check('Excel del conto: righe delle ore e importo approvato', xl.status === 200 && celle.some(c => /Importo approvato\|+8008/.test(c)) && celle.some(c => /Mohamed B\./.test(c)), celle.slice(-3));

    // Ottobre: niente ingressi, tariffa e rasatura cambiate, cartongesso oltre il contratto
    LETTURE['AYAT_ottobre.pdf'] = {
      impresa: 'AYAT S.R.L.S.', cantiere: '', mese: '2026-10', tariffa: 30, totaleScritto: null,
      ore: [{ persona: 'Mohamed B.', giorno: null, ore_foglio: 16 }],
      misura: [
        { voce: 'RASATURA PARETI', unita: 'm²', quantita_foglio: 100, prezzo_foglio: 9, importo_scritto: 900 },
        { voce: 'Posa cartongesso', unita: 'm²', quantita_foglio: 230, prezzo_foglio: 22, importo_scritto: 5060 },
      ],
    };
    d = (await carica(A.id, 'AYAT_ottobre.pdf')).body;
    check('ottobre: nessun ingresso → ore non confrontate; tariffa 30 contro 28; rasatura 9 contro 8,50', d.senzaIngressi === true && !d.ore[0].problema && d.tariffa.problema === 'prezzo_diverso' && d.misura[0].problema === 'prezzo_diverso', { t: d.tariffa, m: d.misura?.map(x => x.problema) });
    const cart = d.misura.find(x => /cartongesso/i.test(x.voce));
    d = (await call('POST', `/conti-sub/${d.id}/contratto`, { company: A.id, body: { riga: cart.id, quantita: 300 } })).body;
    const cart2 = d.misura.find(x => /cartongesso/i.test(x.voce));
    check('quantità del contratto 300: 85 a settembre + 230 = 315 → oltre, proposta 215', cart2.problema === 'oltre_contratto' && cart2.proposta === 215 && cart2.giaApprovato === 85 && /315 m² su 300 m²/.test(cart2.testo.dettaglio), cart2);
    await call('POST', `/conti-sub/${d.id}/decidi`, { company: A.id, body: { riga: 'tariffa', decisione: 'proposta' } });
    await call('POST', `/conti-sub/${d.id}/decidi`, { company: A.id, body: { riga: d.misura.find(x => /rasatura/i.test(x.voce)).id, decisione: 'proposta' } });
    d = (await call('POST', `/conti-sub/${d.id}/decidi`, { company: A.id, body: { riga: cart2.id, decisione: 'proposta' } })).body;
    check('ottobre deciso: 16 × 28 + 100 × 8,50 + 215 × 22 = 6.028 €', d.totali.aperte === 0 && d.totali.totale === 6028, d.totali);
    d = (await call('POST', `/conti-sub/${d.id}/approva`, { company: A.id })).body;
    check('ottobre approvato', d.stato === 'approvato' && d.approvato.totale === 6028);

    // Fatture del sub in Da pagare
    const exp = (amount, invoice) => ({ company_id: A.id, category: 'altro', payment_method: 'bonifico', expense_date: '2026-10-20', da_pagare: true, source: 'manual', pending_review: false, description: 'f360', sollecitato: false, supplier: `${T} AYAT S.R.L.S.`, amount, invoice_number: invoice, data_scadenza: '2026-11-30' });
    await ins('company_expenses', exp(8008, '31'));
    await ins('company_expenses', exp(6328, '44'));
    const dp = (await call('GET', '/da-pagare', { company: A.id })).body;
    const f31 = dp.righe.find(x => x.numeroFattura === '31'), f44 = dp.righe.find(x => x.numeroFattura === '44');
    check('Da pagare: fattura 31 = conto di settembre, differenza 0', f31?.conto?.differenza === 0 && f31.conto.meseTesto === 'settembre 2026', f31?.conto);
    check('Da pagare: fattura 44 = conto di ottobre, 300 € in più', f44?.conto?.differenza === 300 && f44.conto.approvato === 6028, f44?.conto);

    const el = (await call('GET', '/conti-sub', { company: A.id })).body;
    const st = el.storico.find(s => /Ayat/i.test(s.impresa));
    check('storico per impresa e cantiere: approvato 14.036, fatturato 14.336', st && st.approvato === 14036 && st.fatturato === 14336 && st.mesi.length === 2, st);
    check('un\'altra azienda: niente conti', (await call('GET', '/conti-sub', { company: B.id })).body.approvati?.length === 0);

    // Riapri, sostituisci, elimina
    d = (await call('POST', `/conti-sub/${contoSet.id}/riapri`, { company: A.id })).body;
    check('riapri: torna da controllare con le decisioni di prima', d.stato === 'da_controllare' && d.totali.aperte === 0);
    r = await carica(A.id, 'AYAT_settembre.xlsx');
    const { count } = await supabase.from('sub_conti').select('id', { count: 'exact', head: true }).eq('company_id', A.id).eq('mese', '2026-09-01');
    check('foglio corretto per un conto da controllare: lo sostituisce (uno solo)', r.status === 201 && count === 1 && r.body.id !== contoSet.id, { status: r.status, count });
    check('elimina un conto da controllare', (await call('DELETE', `/conti-sub/${r.body.id}`, { company: A.id })).status === 200);
    check('foglio illeggibile: 422', (await carica(A.id, 'altro.xlsx')).status === 422);

    const anon = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
    for (const tb of ['sub_conti', 'sub_conti_righe', 'sub_prezzi']) {
      const { data, error } = await anon.from(tb).select('id').limit(1);
      check(`RLS: ${tb} invisibile con la chiave pubblica`, !!error || (data || []).length === 0, { error: error?.message, n: data?.length });
    }
  } finally {
    server.close();
    for (const c of [A, B]) {
      const { data: files } = await supabase.from('sub_conti').select('file_path').eq('company_id', c.id).not('file_path', 'is', null);
      if (files?.length) await supabase.storage.from('conti-sub').remove(files.map(f => f.file_path)).catch(() => {});
      for (const t of ['sub_prezzi', 'sub_conti_righe', 'sub_conti', 'sub_presenze', 'sub_workers', 'company_expenses', 'company_feature_flags', 'site_subcontractors', 'subcontractors', 'sites']) {
        await supabase.from(t).delete().eq('company_id', c.id);
      }
      await supabase.from('companies').delete().eq('id', c.id);
    }
  }
}

(async () => {
  puri();
  await lettura();
  await rotte();
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
