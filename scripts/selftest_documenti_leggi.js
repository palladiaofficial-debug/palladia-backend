#!/usr/bin/env node
/**
 * scripts/selftest_documenti_leggi.js — F-374 (AUDIT.md del frontend): Documenti «diretto».
 *
 * 1. abbina() (puro): dal foglio letto al proprietario giusto e al requisito
 *    — nome al contrario, targa con spazi, codice fiscale esatto anche col nome
 *    storpiato, DURC con la sola emissione (+120 gg), un corso che non è un
 *    requisito (resta «altro» col suo titolo), un intestatario sconosciuto (di
 *    chi è resta vuoto: lo sceglie il titolare).
 * 2. Contro il DB vero (MSC, sola lettura): panoramica() dà le stesse sezioni
 *    di riepilogo(), le cose da sistemare in ordine (scadute dalla più vecchia,
 *    poi mancanti); leggi() col modello finto abbina a un lavoratore vero.
 */
'use strict';
require('dotenv').config({ quiet: true });
const { abbina, pulisci, leggi } = require('../lib/documentiLeggi');
const { panoramica, riepilogo } = require('../lib/documentiStato');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const MSC = '309e9018-1bcc-4876-9430-99cb89e043dd';

const owners = [
  { kind: 'lavoratori', id: 'w1', name: 'Binozi Armand', row: { fiscal_code: 'BNZRMN85A01Z100X' } },
  { kind: 'lavoratori', id: 'w2', name: 'CATALANO ARIANNA', row: { fiscal_code: null } },
  { kind: 'lavoratori', id: 'w3', name: 'Festim Dervishaj', row: {} },
  { kind: 'mezzi', id: 'm1', name: 'Autocarro NISSAN CABSTAR 120.35', detail: 'BX120CW', row: { type: 'Autocarro', model: 'NISSAN CABSTAR 120.35', plate_or_serial: 'BX120CW' } },
  { kind: 'mezzi', id: 'm2', name: 'Betoniera Imer', row: { type: 'Betoniera', model: 'Imer', plate_or_serial: 'SN-4411' } },
  { kind: 'impresa', id: 'impresa', name: 'MSCedilizia S.r.l.', row: {} },
  { kind: 'subappaltatori', id: 's1', name: 'Edil Ponteggi Rossi S.r.l.', row: {} },
  { kind: 'cantieri', id: 'c1', name: 'Via Balbi 31', row: {} },
];
const L = (x) => pulisci(x);

(async () => {
  console.log('\nF-374 — leggere un foglio e capire di chi è');

  let r = abbina(L({ tipo: 'idoneita', titolo: 'Giudizio di idoneità', intestatario: 'ARMAND BINOZI', tipo_intestatario: 'persona', scadenza: '2027-09-29' }), owners);
  check('visita medica, nome al contrario → Binozi, Visita medica, 29/09/2027', r.proposta.id === 'w1' && r.proposta.requisito === 'idoneita' && r.proposta.label === 'Visita medica' && r.proposta.scadenza === '2027-09-29', r);

  r = abbina(L({ tipo: 'assicurazione', titolo: 'Polizza RC auto', intestatario: 'Nissan Cabstar', tipo_intestatario: 'veicolo', targa: 'BX 120 CW', scadenza: '2027-08-15' }), owners);
  check('polizza con targa «BX 120 CW» → l\'autocarro Nissan, Assicurazione, certezza alta', r.proposta.id === 'm1' && r.proposta.requisito === 'assicurazione' && r.certezza === 'alta', r);

  r = abbina(L({ tipo: 'idoneita', intestatario: 'BINOSI ARMANDO', codice_fiscale: 'bnzrmn85a01z100x', scadenza: '2027-01-01' }), owners);
  check('codice fiscale esatto vince anche col nome storpiato', r.proposta.id === 'w1' && r.certezza === 'alta', r);

  r = abbina(L({ tipo: 'durc', titolo: 'DURC', intestatario: 'MSC EDILIZIA SRL', tipo_intestatario: 'ditta', emissione: '2026-10-01' }), owners);
  check('DURC con la sola emissione → la tua impresa, DURC, scade dopo 120 giorni (29/01/2027)', r.proposta.kind === 'impresa' && r.proposta.requisito === 'durc' && r.proposta.scadenza === '2027-01-29', r);

  r = abbina(L({ tipo: 'durc', intestatario: 'Edil Ponteggi Rossi srl', tipo_intestatario: 'ditta', scadenza: '2027-02-01' }), owners);
  check('DURC di un subappaltatore → quella ditta, non la tua impresa', r.proposta.kind === 'subappaltatori' && r.proposta.id === 's1' && r.proposta.requisito === 'durc', r);

  r = abbina(L({ tipo: 'altro', titolo: 'Attestato corso preposto', intestatario: 'Catalano Arianna', tipo_intestatario: 'persona', scadenza: '2031-05-10' }), owners);
  check('corso preposto → Catalano, nessun requisito, col titolo letto', r.proposta.id === 'w2' && r.proposta.requisito === null && r.proposta.label === 'Attestato corso preposto', r);

  r = abbina(L({ tipo: 'idoneita', intestatario: 'Mario Bianchi', tipo_intestatario: 'persona', scadenza: '2027-03-03' }), owners);
  check('intestatario sconosciuto → di chi è vuoto, certezza nessuna (lo sceglie il titolare)', r.proposta.id === null && r.certezza === 'nessuna' && r.proposta.scadenza === '2027-03-03', r);

  r = abbina(L({ tipo: 'idoneita', intestatario: 'Mario Rossi', tipo_intestatario: 'persona' }), owners);
  check('una persona non finisce mai su una ditta che le somiglia («Rossi» ≠ «Edil Ponteggi Rossi»)', r.proposta.kind !== 'subappaltatori', r);

  // F-400: l'attestato porta la data del corso, non la scadenza: aggiornamento ogni 5 anni
  const att = L({ tipo: 'formazione', intestatario: 'Luca Parodi', emissione: '2026-10-15', scadenza: null });
  check('F-400: formazione con la sola data del corso → scade dopo 5 anni (15/10/2031), segnata come calcolata', att.scadenza === '2031-10-15' && att.scadenzaCalcolata === true, att);
  const att2 = L({ tipo: 'formazione', emissione: '2026-10-15', scadenza: '2030-01-01' });
  check('F-400: se la scadenza è scritta, vale quella scritta', att2.scadenza === '2030-01-01' && !att2.scadenzaCalcolata, att2);
  const vis = L({ tipo: 'idoneita', emissione: '2026-10-15', scadenza: null });
  check('F-400: una visita medica senza scadenza resta senza (la periodicità la decide il medico)', vis.scadenza === null, vis);
  const sporco = pulisci({ tipo: 'boh', scadenza: '31/12/2027', intestatario: { nome: 'X' } });
  check('risposta del modello strana: tipo «altro», data non ISO scartata, niente errori', sporco.tipo === 'altro' && sporco.scadenza === null, sporco);

  // 2. DB vero
  const [p, rie] = await Promise.all([panoramica(MSC), riepilogo(MSC)]);
  check('MSC: sezioni della panoramica = riepilogo', JSON.stringify(p.sezioni) === JSON.stringify(rie), { p: p.sezioni, rie });
  const ordineOk = p.daSistemare.every((x, i, a) => i === 0 || (a[i - 1].state === 'scaduto' && x.state === 'manca')
    || (a[i - 1].state === x.state && (x.state === 'manca' || String(a[i - 1].expiry) <= String(x.expiry))));
  check(`MSC: ${p.daSistemare.length} da sistemare, scadute dalla più vecchia poi mancanti`, p.daSistemare.length > 0 && ordineOk && p.daSistemare.every(x => x.state === 'scaduto' || x.state === 'manca'), p.daSistemare.slice(0, 5));
  check('MSC: entità per la ricerca con nome e tipo', p.entita.length > 0 && p.entita.every(e => e.kind && e.id && e.name), p.entita.length);

  const vero = p.entita.find(e => e.kind === 'lavoratori');
  const out = await leggi({
    companyId: MSC, userId: null, file: { buffer: Buffer.from('x'), mimetype: 'image/jpeg' },
    chiedi: async () => ({ tipo: 'idoneita', intestatario: vero.name.split(' ').reverse().join(' '), tipo_intestatario: 'persona', scadenza: '2027-06-30' }),
  });
  check(`MSC: leggi() col modello finto → ${vero.name}, Visita medica`, out.proposta.id === vero.id && out.proposta.requisito === 'idoneita' && out.letto.scadenza === '2027-06-30', out);

  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
