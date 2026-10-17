#!/usr/bin/env node
/**
 * scripts/selftest_altri_posti.js — F-371 (AUDIT.md del frontend): righe Documenti e POS in fondo a Cantieri.
 *
 * 1. Puri (lib/altriPosti.js::conta): documenti scaduti = voci di Da fare scadute
 *    (fine lavori escluse, le «in corso» no); POS = cantieri al lavoro col POS che manca.
 * 2. Contro il DB vero (MSC, sola lettura): il numero dei documenti è lo stesso
 *    della riga «N documenti scaduti» della home; i cantieri senza POS sono gli
 *    stessi che nella scheda hanno «Manca il POS».
 */
'use strict';
require('dotenv').config({ quiet: true });
const { conta, costruisci } = require('../lib/altriPosti');
const oggi = require('../lib/oggi');
const { riepiloghi } = require('../lib/cantiereRiepilogo');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}
const MSC = '309e9018-1bcc-4876-9430-99cb89e043dd';

(async () => {
  console.log('\nF-371 — Documenti e POS in fondo a Cantieri');
  const items = [
    { kind: 'scadenza', bucket: 'scaduto', type: 'durc' },
    { kind: 'scadenza', bucket: 'scaduto', type: 'visita' },
    { kind: 'scadenza', bucket: 'scaduto', type: 'fine_cantiere' },
    { kind: 'scadenza', bucket: 'settimana', type: 'durc' },
    { kind: 'scadenza', bucket: 'in_corso', type: 'durc' },
    { kind: 'timbratura', bucket: 'scaduto', type: 'missing_exit' },
  ];
  const r = new Map([
    ['a', { alLavoro: true, documenti: { pos: 'manca' } }],
    ['b', { alLavoro: true, documenti: { pos: 'presente' } }],
    ['c', { alLavoro: false, documenti: { pos: 'manca' } }],
    ['d', { alLavoro: true, documenti: { pos: 'non_serve' } }],
  ]);
  const c = conta({ items, riepiloghi: r });
  check('documenti scaduti: 2 (fine lavori, settimana, in corso e timbrature no)', c.documenti.scaduti === 2, c);
  check('POS: 1 cantiere al lavoro senza POS su 3 al lavoro (fermo e «non serve» no)', c.pos.senzaPos === 1 && c.pos.alLavoro === 3, c);
  const vuoto = conta({});
  check('niente dati: zeri, nessun errore', vuoto.documenti.scaduti === 0 && vuoto.pos.senzaPos === 0, vuoto);

  // 2. DB vero, sola lettura
  const [vero, home, rie] = await Promise.all([costruisci(MSC, null, 'owner'), oggi.costruisci(MSC, null, 'owner'), riepiloghi(MSC)]);
  const rigaDoc = [home.prima, ...home.poi].concat([]).find(x => x && x.id === 'documenti-scaduti');
  const daHome = rigaDoc ? Number(rigaDoc.titolo.match(/^(\d+)/)?.[1]) : null;
  console.log(`  MSC: documenti scaduti ${vero.documenti.scaduti} (home: ${rigaDoc ? rigaDoc.titolo : 'riga non tra le prime'}), cantieri senza POS ${vero.pos.senzaPos} su ${vero.pos.alLavoro} al lavoro`);
  if (daHome != null) check('MSC: stesso numero della riga della home', daHome === vero.documenti.scaduti, { daHome, vero: vero.documenti.scaduti });
  else check('MSC: numero dei documenti calcolato', Number.isInteger(vero.documenti.scaduti));
  const conMancaPos = [...rie.values()].filter(x => x.daSistemare.some(d => d.tipo === 'pos')).length;
  check('MSC: cantieri senza POS = schede con «Manca il POS»', conMancaPos === vero.pos.senzaPos, { conMancaPos, vero: vero.pos });

  console.log(`\n${passed} ok, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
