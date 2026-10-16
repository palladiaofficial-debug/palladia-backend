#!/usr/bin/env node
/**
 * scripts/selftest_da_pagare.js — F-338 (AUDIT.md del frontend): Da pagare.
 *
 * Rotte montate su un server locale (login dell'ufficio finto come gli altri
 * test), contro il DB vero:
 *  - modulo spento → 404; ruolo in sola lettura → 403;
 *  - inserimento a mano: controlli, doppione della stessa fattura;
 *  - gruppi: subito (scaduta o sollecitata), settimana, più avanti, da controllare;
 *  - Pagato / non pagato, Rimanda / annulla, "mi ha sollecitato", È giusto, Correggi, Elimina;
 *  - foto allegata e link firmato; lettura di un XML (dati certi);
 *  - Da fare: righe 'pagamento' solo per titolare/amministratori/tecnici;
 *  - card Buongiorno: solo scaduti/sollecitati/entro 3 giorni, tasto "Pagato";
 *  - un'altra azienda non tocca i pagamenti di questa.
 */
'use strict';
require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const jwtPath = path.join(__dirname, '../middleware/verifyJwt.js');
require.cache[jwtPath] = { id: jwtPath, filename: jwtPath, loaded: true, exports: {
  verifySupabaseJwt: (req, _res, next) => { req.companyId = req.get('x-test-company'); req.userRole = req.get('x-test-role') || 'owner'; req.user = { id: null }; next(); },
} };
const supabase = require('../lib/supabase');
const P = require('../lib/daPagare');
const { buildDaFare } = require('../lib/daFare');
const { buildDailyBrief } = require('../lib/dailyBrief');
const { controllaLettura } = require('../lib/daPagareLettura');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const T = `TEST-F338-${Date.now()}`;
const oggi = new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
const fra = (n) => { const d = new Date(`${oggi}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function ins(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

async function main() {
  console.log('\n\x1b[1mF-338 — Da pagare\x1b[0m');
  const app = express(); app.use(express.json());
  app.use('/api/v1', require('../routes/v1/daPagare'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, url, { body, company, role, form } = {}) => {
    const headers = { 'x-test-company': company };
    if (role) headers['x-test-role'] = role;
    let payload;
    if (form) payload = form;
    else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(`${base}${url}`, { method, headers, body: payload });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const nuovo = (A, campi, file) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(campi)) f.append(k, String(v));
    if (file) f.append('file', new Blob([file.buffer], { type: file.type }), file.name);
    return call('POST', '/da-pagare', { company: A, form: f });
  };

  const A = await ins('companies', { name: `${T}-A` });
  const B = await ins('companies', { name: `${T}-B` });
  let userId = null;
  try {
    check('modulo spento: 404', (await call('GET', '/da-pagare', { company: A.id })).status === 404);
    await ins('company_feature_flags', { company_id: A.id, feature: 'da_pagare', enabled: true });
    await ins('company_feature_flags', { company_id: B.id, feature: 'da_pagare', enabled: true });
    check('ruolo in sola lettura: 403', (await call('GET', '/da-pagare', { company: A.id, role: 'viewer' })).status === 403);
    check('tecnico: vede la lista', (await call('GET', '/da-pagare', { company: A.id, role: 'tech' })).status === 200);

    // ── Inserimento ──
    check('senza importo: 400', (await nuovo(A.id, { fornitore: 'Bianchi', entro: oggi })).body.error === 'IMPORTO');
    check('data sbagliata: 400', (await nuovo(A.id, { fornitore: 'Bianchi', importo: '10', entro: '31/12' })).body.error === 'DATA');
    const scaduta = await nuovo(A.id, { fornitore: 'Ferramenta Bianchi', importo: '640,00', entro: fra(-3) });
    check('a mano: "640,00" letto come 640 €', scaduta.status === 201 && scaduta.body.importo === 640 && scaduta.body.gruppo === 'subito', scaduta.body);
    const sett = await nuovo(A.id, { fornitore: 'Edilmateriali Rossi Srl', importo: '1.840,00', entro: fra(2), numeroFattura: '412' });
    check('"1.840,00" letto come 1.840 € e in "questa settimana"', sett.body.importo === 1840 && sett.body.gruppo === 'settimana' && /fattura n\. 412/.test(sett.body.sottotitolo), sett.body);
    const dopp = await nuovo(A.id, { fornitore: 'EDILMATERIALI ROSSI S.R.L.', importo: '1840', entro: fra(5), numeroFattura: '412' });
    check('stessa fattura (fornitore, numero, importo): 409 doppione', dopp.status === 409 && dopp.body.error === 'DOPPIONE', dopp.body);
    const foto = { buffer: Buffer.from('\xFF\xD8\xFF\xE0finta-foto'), type: 'image/jpeg', name: 'fattura.jpg' };
    const avanti = await nuovo(A.id, { fornitore: 'Noleggio Gru Ligure', importo: '2300', entro: fra(20), sollecitato: 'true' }, foto);
    check('sollecitata anche se lontana: subito', avanti.body.gruppo === 'subito' && avanti.body.sollecitato === true && avanti.body.conFoto === true, avanti.body);
    const fl = await call('GET', `/da-pagare/${avanti.body.id}/foto`, { company: A.id });
    check('foto allegata: link firmato', fl.status === 200 && /^https?:\/\//.test(fl.body.url || ''), fl.body);
    const lontana = await nuovo(A.id, { fornitore: 'Carburanti Levante', importo: '415.50', entro: fra(25) });
    check('più avanti', lontana.body.gruppo === 'piu_avanti' && lontana.body.importo === 415.5, lontana.body);

    let L = (await call('GET', '/da-pagare', { company: A.id })).body;
    check('elenco: subito prima, poi settimana, poi più avanti', L.righe.map(r => r.gruppo).join(',') === 'subito,subito,settimana,piu_avanti', L.righe.map(r => r.gruppo));
    check('totale della settimana = scaduti/sollecitati + 7 giorni (640 + 2.300 + 1.840)', L.totaleSettimana === 4780 && L.totaleSettimanaTesto === '4.780,00 €', L.totaleSettimana);
    // F-357: il totale di tutto, in cima alla pagina
    check('F-357: totale di tutto (640 + 1.840 + 2.300 + 415,50)', L.totale === 5195.5 && L.totaleTesto === '5.195,50 €', [L.totale, L.totaleTesto]);
    check('F-357: nome da mostrare senza forma societaria, chiave per raggruppare', L.righe.find(x => x.id === sett.body.id)?.nome === 'Edilmateriali Rossi' && L.righe.find(x => x.id === sett.body.id)?.chiave === 'edilmateriali rossi', L.righe.find(x => x.id === sett.body.id));

    // ── F-357: IBAN e "pagata il" ──
    const IBAN = 'IT60X0542811101000000123456';
    const conIban = await nuovo(A.id, { fornitore: 'Ponteggi Riviera', importo: '300', entro: fra(4), iban: 'it60 x054 2811 1010 0000 0123 456' });
    check('F-357: IBAN salvato normalizzato', conIban.status === 201 && conIban.body.iban === IBAN, conIban.body);
    const ibanSbagliato = await nuovo(A.id, { fornitore: 'Ponteggi Riviera Due', importo: '300', entro: fra(4), iban: 'IT60X0542811101000000123457' });
    check('F-357: IBAN con una cifra sbagliata: non salvato', ibanSbagliato.status === 201 && ibanSbagliato.body.iban === null, ibanSbagliato.body);
    let r = await call('PATCH', `/da-pagare/${ibanSbagliato.body.id}`, { company: A.id, body: { iban: 'IT00 1234' } });
    check('F-357: Correggi con IBAN non valido: 400', r.status === 400 && r.body.error === 'IBAN', r.body);
    r = await call('POST', `/da-pagare/${ibanSbagliato.body.id}/pagato`, { company: A.id, body: { il: fra(1) } });
    check('F-357: pagata domani: 400', r.status === 400 && r.body.error === 'DATA', r.body);
    r = await call('POST', `/da-pagare/${ibanSbagliato.body.id}/pagato`, { company: A.id, body: { il: fra(-1) } });
    check('F-357: "pagata ieri": la data è ieri', r.status === 200 && r.body.pagatoIl === fra(-1), r.body);
    r = await call('POST', `/da-pagare/${conIban.body.id}/pagato`, { company: A.id, body: { today: '2020-01-01' } });
    check('F-357: un "today" nel corpo della richiesta è ignorato', r.status === 200 && r.body.pagatoIl === oggi, r.body);
    for (const x of [conIban, ibanSbagliato]) await supabase.from('company_expenses').delete().eq('id', x.body.id);

    // ── Azioni ──
    r = await call('POST', `/da-pagare/${scaduta.body.id}/pagato`, { company: A.id });
    L = (await call('GET', '/da-pagare', { company: A.id })).body;
    check('Pagato: esce dalla lista e va in "pagati questo mese"', r.body.pagatoIl === oggi && !L.righe.some(x => x.id === scaduta.body.id) && L.pagatiQuestoMese.some(x => x.id === scaduta.body.id), r.body);
    r = await call('POST', `/da-pagare/${scaduta.body.id}/non-pagato`, { company: A.id });
    check('Annulla (non pagato): torna in lista', r.body.pagatoIl === null && r.body.gruppo === 'subito', r.body);
    r = await call('POST', `/da-pagare/${avanti.body.id}/rimanda`, { company: A.id, body: { giorni: 7 } });
    check('Rimanda di una settimana: niente sollecito, più avanti', r.body.sollecitato === false && r.body.gruppo === 'piu_avanti' && r.body.data === fra(20), r.body);
    r = await call('POST', `/da-pagare/${scaduta.body.id}/rimanda`, { company: A.id, body: { giorni: 1 } });
    check('Rimanda di un giorno una scaduta: "entro domani"', r.body.data === fra(1) && r.body.gruppo === 'settimana' && /rimandata/.test(r.body.sottotitolo), r.body);
    r = await call('POST', `/da-pagare/${scaduta.body.id}/annulla-rimanda`, { company: A.id, body: {} });
    check('Annulla il rimando: torna scaduta', r.body.gruppo === 'subito' && r.body.data === fra(-3), r.body);
    r = await call('PATCH', `/da-pagare/${lontana.body.id}`, { company: A.id, body: { sollecitato: true } });
    check('"Mi ha sollecitato" su una lontana: subito', r.body.gruppo === 'subito', r.body);
    r = await call('PATCH', `/da-pagare/${lontana.body.id}`, { company: A.id, body: { sollecitato: false, importo: '420', entro: fra(10) } });
    check('Correggi importo e data', r.body.importo === 420 && r.body.data === fra(10) && r.body.gruppo === 'piu_avanti', r.body);
    check('rimanda di 0 giorni: 400', (await call('POST', `/da-pagare/${lontana.body.id}/rimanda`, { company: A.id, body: { giorni: 0 } })).status === 400);

    // Da controllare (come arriva da un PDF per email) → È giusto
    const pdf = await ins('company_expenses', { company_id: A.id, amount: 980, description: 'Fattura Cementi', supplier: 'Cementi Tigullio Srl', data_scadenza: fra(13), source: 'email', da_pagare: true, pending_review: true, pending_review_reason: 'OCR' });
    L = (await call('GET', '/da-pagare', { company: A.id })).body;
    const dc = L.righe.find(x => x.id === pdf.id);
    check('letta da un PDF: "da controllare", subito dopo le urgenti', dc?.gruppo === 'da_controllare' && /letta da un'email/.test(dc.sottotitolo) && L.righe.findIndex(x => x.id === pdf.id) === L.righe.filter(x => x.gruppo === 'subito').length, L.righe.map(x => x.gruppo));
    r = await call('POST', `/da-pagare/${pdf.id}/conferma`, { company: A.id });
    check('È giusto: diventa una riga normale', r.body.daControllare === false && r.body.gruppo === 'piu_avanti', r.body);

    // ── Lettura di un XML: dati certi ──
    const xml = `<?xml version="1.0" encoding="UTF-8"?><p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12"><FatturaElettronicaHeader><CedentePrestatore><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>01234567890</IdCodice></IdFiscaleIVA><Anagrafica><Denominazione>Laterizi Liguri Srl</Denominazione></Anagrafica></DatiAnagrafici></CedentePrestatore></FatturaElettronicaHeader><FatturaElettronicaBody><DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Numero>77</Numero><Data>2026-10-01</Data><ImportoTotaleDocumento>1220.00</ImportoTotaleDocumento></DatiGeneraliDocumento></DatiGenerali><DatiBeniServizi><DettaglioLinee><Descrizione>Mattoni</Descrizione></DettaglioLinee></DatiBeniServizi><DatiPagamento><CondizioniPagamento>TP02</CondizioniPagamento><DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>2026-10-31</DataScadenzaPagamento><ImportoPagamento>1220.00</ImportoPagamento></DettaglioPagamento></DatiPagamento></FatturaElettronicaBody></p:FatturaElettronica>`;
    const fx = new FormData(); fx.append('file', new Blob([xml], { type: 'application/xml' }), 'IT01234567890_00077.xml');
    const lx = await call('POST', '/da-pagare/leggi', { company: A.id, form: fx });
    check('XML: fornitore, importo, scadenza e numero certi, senza IA', lx.status === 200 && lx.body.certa === true && lx.body.importo === 1220 && lx.body.scadenza === '2026-10-31' && lx.body.numero === '77' && /Laterizi/.test(lx.body.fornitore), lx.body);
    const fz = new FormData(); fz.append('file', new Blob(['ciao'], { type: 'text/plain' }), 'nota.txt');
    check('file che non è una fattura: rifiutato', (await call('POST', '/da-pagare/leggi', { company: A.id, form: fz })).status === 400);

    // Risposta dell'IA (regole pure)
    check('IA: scadenza non scritta → nessuna data inventata', controllaLettura({ leggibile: true, fornitore: 'Rossi', totale_da_pagare: '1.840,00', scadenza: '', numero_fattura: '' })?.scadenza === null);
    check('IA: "1.840,00" → 1840', controllaLettura({ leggibile: true, fornitore: 'Rossi', totale_da_pagare: '1.840,00', scadenza: '2026-10-20', numero_fattura: '1' })?.importo === 1840);
    const xmlIban = xml.replace('<ImportoPagamento>', '<IBAN>IT60X0542811101000000123456</IBAN><ImportoPagamento>');
    const fxi = new FormData(); fxi.append('file', new Blob([xmlIban], { type: 'application/xml' }), 'IT01234567890_00078.xml');
    const lxi = await call('POST', '/da-pagare/leggi', { company: A.id, form: fxi });
    check('F-357: XML con IBAN: IBAN letto', lxi.status === 200 && lxi.body.iban === 'IT60X0542811101000000123456', lxi.body);
    check('F-357: XML senza IBAN: null', lx.body.iban === null, lx.body);
    check('F-357: IA, IBAN letto male (controllo che non torna) → null', controllaLettura({ leggibile: true, fornitore: 'Rossi', totale_da_pagare: '10', scadenza: '', numero_fattura: '', iban: 'IT60X0542811101000000123465' })?.iban === null);
    check('F-357: IA, IBAN con spazi → normalizzato', controllaLettura({ leggibile: true, fornitore: 'Rossi', totale_da_pagare: '10', scadenza: '', numero_fattura: '', iban: 'IT60 X054 2811 1010 0000 0123 456' })?.iban === 'IT60X0542811101000000123456');

    // F-357: nomi dei fornitori come quelli veri di MSCedilizia (16/10)
    check('F-357: "GUARDALA\' GIUSEPPINA" → "Guardalà Giuseppina"', P.nomeBreve("GUARDALA' GIUSEPPINA") === 'Guardalà Giuseppina', P.nomeBreve("GUARDALA' GIUSEPPINA"));
    check('F-357: "STELLI IMPIANTI DI STELLI MARCO" → "Stelli Impianti di Stelli Marco"', P.nomeBreve('STELLI IMPIANTI DI STELLI MARCO') === 'Stelli Impianti di Stelli Marco');
    check('F-357: "WC LOC ITALIA S.r.l." e "WC Loc Italia S.r.l. Unipersonale": stesso nome e stessa chiave',
      P.nomeBreve('WC LOC ITALIA S.r.l.') === 'WC Loc Italia' && P.nomeBreve('WC Loc Italia S.r.l. Unipersonale') === 'WC Loc Italia'
      && P.normNome('WC LOC ITALIA S.r.l.') === P.normNome('WC Loc Italia S.r.l. Unipersonale'), [P.nomeBreve('WC LOC ITALIA S.r.l.'), P.normNome('WC Loc Italia S.r.l. Unipersonale')]);
    check('F-357: nome scritto normale resta com\'è', P.nomeBreve('Edil-Sud S.p.A.') === 'Edil-Sud' && P.nomeBreve("D'ANGELO COSTRUZIONI SNC") === "D'Angelo Costruzioni");

    // F-357: riassunto per "Tutto" e Buongiorno, con le 5 fatture vere del 16/10
    const vere = [["GUARDALA' GIUSEPPINA", 4702], ['STELLI IMPIANTI DI STELLI MARCO', 600], ['STELLI IMPIANTI DI STELLI MARCO', 1500], ['WC LOC ITALIA S.r.l.', 3450.91], ['WC Loc Italia S.r.l. Unipersonale', 922.47]]
      .map(([f, a]) => ({ kind: 'pagamento', title: f, nome: P.nomeBreve(f), chiave: P.normNome(f), importo: a, days: -1, sollecitato: true, daControllare: false }));
    const ria = P.riassuntoPagamenti(vere);
    check('F-357: riassunto: "5 fatture da pagare, tutte scadute", 11.175,38 €', ria.titolo === '5 fatture da pagare, tutte scadute' && ria.totaleTesto === '11.175,38 €' && ria.urgente, ria);
    check('F-357: riassunto: tre fornitori, il più grosso per primo, tutti hanno sollecitato', ria.dettaglio === 'Guardalà Giuseppina, WC Loc Italia, Stelli Impianti di Stelli Marco · tutti hanno sollecitato', ria.dettaglio);
    const ria2 = P.riassuntoPagamenti([{ kind: 'pagamento', title: 'Rossi', importo: 10, days: 1, sollecitato: false }, { kind: 'pagamento', title: 'Bianchi', importo: 5, days: 20, sollecitato: true }, { kind: 'scadenza', title: 'x', days: -3 }]);
    check('F-357: riassunto misto: niente scadute, uno ha sollecitato, solo i pagamenti', ria2.n === 2 && ria2.titolo === '2 fatture da pagare, una scade domani' && /1 ha sollecitato/.test(ria2.dettaglio) && ria2.totale === 15, ria2);
    check('F-357: nessun pagamento → nessun riassunto', P.riassuntoPagamenti([{ kind: 'scadenza', days: -1 }]) === null);
    check('IA: non leggibile → null', controllaLettura({ leggibile: false, fornitore: '', totale_da_pagare: '', scadenza: '', numero_fattura: '' }) === null);

    // ── Altra azienda ──
    check('un\'altra azienda non segna pagato: 404', (await call('POST', `/da-pagare/${sett.body.id}/pagato`, { company: B.id })).status === 404);
    check('un\'altra azienda non vede la foto: 404', (await call('GET', `/da-pagare/${avanti.body.id}/foto`, { company: B.id })).status === 404);
    check('un\'altra azienda: lista vuota', (await call('GET', '/da-pagare', { company: B.id })).body.righe?.length === 0);

    // ── Da fare ──
    const dfOwner = await buildDaFare(A.id, null, { role: 'owner' });
    const pag = dfOwner.items.filter(i => i.kind === 'pagamento');
    check('Da fare (titolare): le righe di Da pagare ci sono, la scaduta tra le scadute', pag.length === 5 && pag.find(i => i.pagamentoId === scaduta.body.id)?.bucket === 'scaduto', pag.map(i => [i.title, i.bucket]));
    check('Da fare (tecnico): ci sono', (await buildDaFare(A.id, null, { role: 'tech' })).items.some(i => i.kind === 'pagamento'));
    check('Da fare (sola lettura): non ci sono', !(await buildDaFare(A.id, null, { role: 'viewer' })).items.some(i => i.kind === 'pagamento'));
    check('Da fare senza utente (lavagna, email di avviso): non ci sono', !(await buildDaFare(A.id, null)).items.some(i => i.kind === 'pagamento'));

    // ── Card Buongiorno (utente vero, ruolo dal DB) ──
    const { data: u, error: ue } = await supabase.auth.admin.createUser({ email: `f338-${Date.now()}@example.com`, email_confirm: true, password: crypto.randomBytes(12).toString('hex') });
    if (ue) throw new Error(ue.message);
    userId = u.user.id;
    await ins('company_users', { company_id: A.id, user_id: userId, role: 'owner' });
    const brief = await buildDailyBrief(A.id, userId);
    // F-357: una riga sola per i pagamenti, senza "Pagato" (prima: una per fattura, segnabile pagata dalla home)
    const bp = brief.alerts.filter(a => String(a.id).startsWith('pagamento'));
    const riga1 = brief.alerts.find(a => a.id === 'pagamenti');
    check('F-357: Buongiorno: niente righe per fattura', !brief.alerts.some(a => String(a.id).startsWith('pagamento:')), bp.map(a => a.id));
    check('F-357: Buongiorno: una riga "pagamenti" in cima, senza tasto, con il totale e il link', riga1 && brief.alerts[0].id === 'pagamenti' && riga1.action === null && riga1.link === '/scadenze?type=pagare' && riga1.amount === dfOwner.pagamenti.totaleTesto && /^5 fatture da pagare/.test(riga1.title) && riga1.severity === 'critical', riga1);
    check('F-357: Da fare: riassunto dei pagamenti con lo stesso totale della lista', dfOwner.pagamenti?.n === 5 && dfOwner.pagamenti.totale === (await call('GET', '/da-pagare', { company: A.id })).body.totale, dfOwner.pagamenti);

    // ── Elimina ──
    r = await call('DELETE', `/da-pagare/${lontana.body.id}`, { company: A.id });
    check('Elimina: sparisce', r.status === 200 && !(await call('GET', '/da-pagare', { company: A.id })).body.righe.some(x => x.id === lontana.body.id));
  } finally {
    server.close();
    const { data: rows } = await supabase.from('company_expenses').select('receipt_url').eq('company_id', A.id).not('receipt_url', 'is', null);
    if (rows?.length) await supabase.storage.from('site-documents').remove(rows.map(x => x.receipt_url)).catch(() => {});
    for (const c of [A, B]) {
      for (const t of ['company_expenses', 'company_feature_flags', 'company_users']) await supabase.from(t).delete().eq('company_id', c.id);
      await supabase.from('companies').delete().eq('id', c.id);
    }
    if (userId) await supabase.auth.admin.deleteUser(userId).catch(() => {});
  }
  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
