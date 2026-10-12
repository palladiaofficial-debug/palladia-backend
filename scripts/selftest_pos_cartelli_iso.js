#!/usr/bin/env node
/**
 * scripts/selftest_pos_cartelli_iso.js — F-341 (AUDIT.md del frontend).
 *
 * Sezione 6 del POS: ogni cartello porta il codice ISO 7010. Il 12/10 erano
 * sbagliati proprio i più importanti: casco M002 (= "consultare il manuale"),
 * imbracatura M014 (= casco), caduta W009 (= rischio biologico), divieto di
 * accesso P006 (= vietato ai carrelli elevatori), irritanti W026. Qui ogni
 * cartello deve avere il codice giusto, oppure nessun codice ISO quando il
 * cartello non è un pittogramma ISO 7010 (cartelli del D.Lgs. 81/08 All. XXV
 * con testo: rumore, irritanti, gas, transito veicoli, accesso vietato).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { selectSigns } = require('../sign-selector');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}

// Codice atteso per nome del cartello (null = nessun codice ISO 7010)
const ATTESO = {
  'Obbligo casco di protezione': 'M014',
  'Obbligo imbracatura di sicurezza': 'M018',
  'Obbligo calzature di sicurezza': 'M008',
  'Obbligo guanti di protezione': 'M009',
  'Obbligo lavaggio mani': 'M011',
  'Obbligo occhiali di protezione': 'M004',
  'Obbligo protezione facciale': 'M013',
  'Obbligo protezione vie respiratorie': 'M017',
  'Obbligo protezione udito': 'M003',
  'Obbligo passaggio pedoni': 'M024',
  'Pericolo di caduta': 'W008',
  'Pericolo generale': 'W001',
  'Pericolo cantiere (lavori in corso)': 'W001',
  'Pericolo macchine in movimento': 'W001',
  'Pericolo di inciampo': 'W007',
  'Pericolo di scivolamento': 'W011',
  'Pericolo alta tensione': 'W012',
  'Pericolo elettrico generale': 'W012',
  'Pericolo carichi sospesi': 'W015',
  'Pericolo sostanze velenose': 'W016',
  'Pericolo materiale infiammabile': 'W021',
  'Pericolo sostanze corrosive': 'W023',
  'Pericolo sostanze irritanti': null,
  'Pericolo rumore': null,
  'Pericolo gas': null,
  'Divieto di accesso ai non addetti': null,
  'Divieto di transito ai veicoli': null,
  'Vietato fumare': 'P002',
  'Vietato fumare e usare fiamme libere': 'P003',
  'Divieto di passaggio ai pedoni': 'P004',
  'Divieto di bere acqua non potabile': 'P005',
  'Divieto di spegnere con acqua': 'P011',
  'Pronto soccorso': 'E003',
  'Percorso di esodo': 'E001',
  'Uscita di emergenza basso': 'E001',
  'Telefono di emergenza': 'E004',
  'Punto di raccolta': 'E007',
  'Lavaocchi di emergenza': 'E011',
  'Doccia di emergenza': 'E012',
  'Estintore': 'F001',
  'Allarme antincendio': 'F005',
  'Pulsante di emergenza': 'F005',
};

console.log('\n\x1b[1mF-341 — codici ISO 7010 dei cartelli del POS\x1b[0m');

// Tutti i cartelli dichiarati nel file (nome → codici trovati)
const src = fs.readFileSync(path.join(__dirname, '..', 'sign-selector.js'), 'utf8');
const re = /s(?:Root)?\((?:CAT_\w+,\s*)?(['"])(.+?)\.jpg\1[\s\S]*?\n\s*(['"])([^'"\n]*)\3\s*\)/g;
const trovati = new Map();
for (const m of src.matchAll(re)) {
  const nome = m[2];
  const iso = (m[4].match(/ISO\s+7010\s+([A-Z]\d{3})/) || [])[1] || null;
  if (!trovati.has(nome)) trovati.set(nome, new Set());
  trovati.get(nome).add(iso);
}
check('il file dichiara i cartelli (lettura del sorgente funziona)', trovati.size >= 35, trovati.size);
for (const [nome, codici] of trovati) {
  if (nome === 'Cartello generale') continue;
  if (!(nome in ATTESO)) { check(`cartello "${nome}" conosciuto dal test`, false, [...codici]); continue; }
  const atteso = ATTESO[nome];
  check(`${nome}: ${atteso || 'nessun codice ISO'}`, codici.size === 1 && [...codici][0] === atteso, [...codici]);
}

// Nel PDF: un POS con lavori in quota mostra M018 per l'imbracatura e W008 per la caduta
const signs = selectSigns({ selectedWorks: ['Lavori sul ponteggio', 'Montaggio ponteggio'], lavoriInQuota: 'Sì, dal ponteggio' });
const by = (n) => signs.find(s => s.name === n);
check('POS con lavori in quota: c\'è "Pericolo di caduta" con W008', /ISO 7010 W008/.test(by('Pericolo di caduta')?.norm || ''), by('Pericolo di caduta'));
check('...e "Obbligo imbracatura" con M018', /ISO 7010 M018/.test(by('Obbligo imbracatura di sicurezza')?.norm || ''), by('Obbligo imbracatura di sicurezza'));
check('...e il casco con M014', /ISO 7010 M014/.test(by('Obbligo casco di protezione')?.norm || ''), by('Obbligo casco di protezione'));
const nomi = signs.map(s => s.name);
check('nessun cartello ripetuto due volte con lo stesso significato (accesso vietato)', !(nomi.includes('Divieto di accesso ai non addetti') && nomi.includes("Vietato l'accesso al personale non autorizzato")), nomi);

// F-342: cartelli pertinenti, non scelti da parole dentro altre parole
const nomiDi = (pd) => selectSigns(pd).map(x => x.name);
const vero = nomiDi({ selectedSchede: ['ponteggio-uso', 'guaina-fiamma', 'tinteggiature'], selectedWorks: ['Lavori sul ponteggio', 'Impermeabilizzazione con guaina a fiamma', 'Tinteggiature e verniciature'], workType: 'Lavori in quota, Caldo e chimico, Finiture', siteAddress: 'Via Lucarno 45' });
check('guaina a fiamma: niente visiera "saldatura ad arco"', !vero.includes('Obbligo protezione facciale'), vero);
check('guaina a fiamma: vietato usare fiamme libere e materiale infiammabile ci sono', vero.includes('Vietato fumare e usare fiamme libere') && vero.includes('Pericolo materiale infiammabile'), vero);
check('categoria "Caldo e chimico": niente doccia di emergenza, corrosivi, veleni', !vero.includes('Doccia di emergenza') && !vero.includes('Pericolo sostanze corrosive') && !vero.includes('Pericolo sostanze velenose'), vero);
const sald = nomiDi({ selectedWorks: ['Saldatura e taglio termico dei metalli'] });
check('saldatura vera: visiera sì', sald.includes('Obbligo protezione facciale'), sald);
const parole = nomiDi({ selectedWorks: ['Miglioramento sismico del gruppo scale', 'Basamento del parco giochi'] });
check('"gruppo", "parco", "basamento", "miglioramento" non accendono gru, saldatura, chimici', !parole.includes('Pericolo carichi sospesi') && !parole.includes('Obbligo protezione facciale') && !parole.includes('Pericolo sostanze corrosive'), parole);
const gru = nomiDi({ selectedWorks: ['Movimentazione di carichi con gru a torre'] });
check('gru vera: carichi sospesi sì', gru.includes('Pericolo carichi sospesi'), gru);

console.log(`\n${passed} passati, ${failed} falliti`);
process.exit(failed ? 1 : 0);
