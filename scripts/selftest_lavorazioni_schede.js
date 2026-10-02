#!/usr/bin/env node
/**
 * scripts/selftest_lavorazioni_schede.js — F-261 (AUDIT.md del frontend), passo 1.
 *
 * Le schede lavorazione sono la fonte unica per POS, Ladia e carosello in
 * timbratura. Questo test fallisce se una scheda torna vaga o incompleta:
 *  1) struttura: campi obbligatori, id unici, P e D tra 1 e 4;
 *  2) riferimenti: ogni DPI e ogni formazione citati esistono;
 *  3) carosello: cartello valido, frasi brevi (leggibili da un operaio);
 *  4) copertura: le lavorazioni ad alto rischio non mancano;
 *  5) voci vecchie: TUTTE le voci del vecchio catalogo (backend + quelle solo
 *     nel frontend) finiscono in una scheda o tra le escluse con un motivo,
 *     mai in entrambe, mai in due schede; locali e servizi non diventano schede;
 *  6) nessun duplicato di nome.
 * Nessun accesso al DB.
 */
'use strict';
const S = require('../lib/lavorazioniSchede');
const { lavorazioniDatabase } = require('../lib/lavorazioniCatalog');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
}

console.log('\n\x1b[1mF-261 — Schede lavorazione: complete, coerenti, senza buchi\x1b[0m');

const ids = S.SCHEDE.map(s => s.id);
check(`almeno 55 schede (${ids.length})`, ids.length >= 55, ids.length);
check('id unici', new Set(ids).size === ids.length, ids.filter((x, i) => ids.indexOf(x) !== i));
const nomi = S.SCHEDE.map(s => s.nome.toLowerCase());
check('nomi unici', new Set(nomi).size === nomi.length, nomi.filter((x, i) => nomi.indexOf(x) !== i));

// 1) struttura
const categorie = new Set(S.CATEGORIE.map(c => c.id));
const incomplete = [];
for (const s of S.SCHEDE) {
  const minimi = s.pericolosita === 'alta' ? 3 : 2;
  const ok = /^[a-z0-9-]+$/.test(s.id) && s.nome && s.descrizione && s.descrizione.length >= 40
    && categorie.has(s.categoria) && ['alta', 'media'].includes(s.pericolosita)
    && Array.isArray(s.fasi) && s.fasi.length >= 2
    && Array.isArray(s.rischi) && s.rischi.length >= (s.id === 'linee-aeree' ? 1 : minimi)
    && Array.isArray(s.misure) && s.misure.length >= minimi
    && Array.isArray(s.dpi) && s.dpi.length >= 2
    && Array.isArray(s.attrezzature) && s.attrezzature.length >= 1
    && Array.isArray(s.formazione) && s.formazione.length >= 1
    && Array.isArray(s.norme) && s.norme.length >= 1
    && Array.isArray(s.sostituisce);
  if (!ok) incomplete.push(s.id);
}
check('ogni scheda ha descrizione, fasi, rischi, misure, DPI, attrezzature, formazione, norme', incomplete.length === 0, incomplete);

const pdErr = [];
for (const s of S.SCHEDE) for (const [r, p, d] of s.rischi) {
  if (!r || ![1, 2, 3, 4].includes(p) || ![1, 2, 3, 4].includes(d)) pdErr.push(`${s.id}: ${r}`);
}
check('P e D sempre tra 1 e 4', pdErr.length === 0, pdErr);

const attErr = [];
for (const s of S.SCHEDE) for (const a of s.attrezzature) if (!Array.isArray(a) || a.length !== 2 || !a[0] || !a[1]) attErr.push(s.id);
check('ogni attrezzatura ha nome e verifica', attErr.length === 0, attErr);

// Le schede ad alta pericolosità devono avere almeno un rischio con R >= 8
const senzaAlto = S.SCHEDE.filter(s => s.pericolosita === 'alta' && !S.rischiValutati(s).some(r => r.r >= 8)).map(s => s.id);
check('ogni scheda "alta" ha almeno un rischio di livello Alto', senzaAlto.length === 0, senzaAlto);
check('livello: 16 → Molto alto, 8 → Alto, 4 → Medio, 2 → Basso',
  S.livello(16) === 'Molto alto' && S.livello(8) === 'Alto' && S.livello(4) === 'Medio' && S.livello(2) === 'Basso');

// 2) riferimenti
const dpiErr = [], formErr = [];
for (const s of S.SCHEDE) {
  for (const d of s.dpi) if (!S.DPI[d]) dpiErr.push(`${s.id}: ${d}`);
  for (const f of s.formazione) if (!S.FORMAZIONE[f]) formErr.push(`${s.id}: ${f}`);
}
check('ogni DPI citato esiste nel dizionario', dpiErr.length === 0, dpiErr);
check('ogni formazione citata esiste nel dizionario', formErr.length === 0, formErr);
check('ogni DPI ha nome e norma', Object.values(S.DPI).every(d => d.nome && /EN|CEI/.test(d.norma)));

// 3) carosello: un cartello, due frasi brevi che finiscono con il punto
const carErr = [];
for (const s of S.SCHEDE) {
  const c = s.carosello || {};
  const cart = c.cartello || {};
  const prefisso = { divieto: 'P', obbligo: 'M', pericolo: 'W' }[cart.tipo];
  const ok = S.TIPI_CARTELLO.includes(cart.tipo) && prefisso && new RegExp(`^${prefisso}\\d{3}$`).test(cart.iso7010)
    && typeof c.pericolo === 'string' && c.pericolo.length <= 34 && c.pericolo.endsWith('.')
    && typeof c.regola === 'string' && c.regola.length <= 34 && c.regola.endsWith('.');
  if (!ok) carErr.push(`${s.id}: ${JSON.stringify(c)}`);
}
check('carosello: cartello coerente con il tipo e frasi entro 34 caratteri', carErr.length === 0, carErr);

// 4) copertura: le lavorazioni pericolose che mancavano nel vecchio catalogo
const obbligatorie = [
  'ponteggio-montaggio', 'ponteggio-uso', 'trabattello', 'ple', 'scale-portatili', 'aperture-vuoti',
  'coperture-lavori', 'coperture-fragili', 'scavo-trincea', 'scavo-sottoservizi',
  'demolizione-strutture', 'demolizione-meccanica', 'amianto-compatto', 'taglio-calcestruzzo',
  'getto-calcestruzzo', 'disarmo', 'gru-torre-uso', 'autogru', 'mezzi-movimento-terra',
  'guaina-fiamma', 'saldatura-taglio', 'impianti-elettrici', 'linee-aeree', 'spazi-confinati', 'lavori-stradali',
];
const mancanti = obbligatorie.filter(id => !S.getScheda(id));
check('presenti tutte le lavorazioni ad alto rischio', mancanti.length === 0, mancanti);
const perCat = S.CATEGORIE.filter(c => !S.SCHEDE.some(s => s.categoria === c.id)).map(c => c.id);
check('nessuna categoria vuota', perCat.length === 0, perCat);

// 5) voci del vecchio catalogo
const vecchie = new Set();
for (const c of lavorazioniDatabase) for (const v of c.items) vecchie.add(v);
for (const v of S.VOCI_SOLO_FRONTEND) vecchie.add(v);
const inesistenti = [], doppie = [];
const viste = new Map();
for (const s of S.SCHEDE) for (const v of s.sostituisce) {
  if (!vecchie.has(v)) inesistenti.push(`${s.id}: ${v}`);
  if (viste.has(v)) doppie.push(`${v} (${viste.get(v)} e ${s.id})`);
  viste.set(v, s.id);
}
check('ogni voce sostituita esiste nel vecchio catalogo', inesistenti.length === 0, inesistenti);
check('ogni voce vecchia è mappata a una sola scheda', doppie.length === 0, doppie);
const orfane = [...vecchie].filter(v => !viste.has(v) && !S.VOCI_ESCLUSE[v]);
check(`ogni voce vecchia (${vecchie.size}) è in una scheda o esclusa con motivo`, orfane.length === 0, orfane);
const entrambe = Object.keys(S.VOCI_ESCLUSE).filter(v => viste.has(v));
check('nessuna voce è sia in una scheda sia esclusa', entrambe.length === 0, entrambe);
const esclInesistenti = Object.keys(S.VOCI_ESCLUSE).filter(v => !vecchie.has(v));
check('ogni voce esclusa esiste nel vecchio catalogo', esclInesistenti.length === 0, esclInesistenti);
check('ogni esclusione ha un motivo', Object.values(S.VOCI_ESCLUSE).every(m => typeof m === 'string' && m.length >= 20));
const locali = ['Ufficio direzione lavori', 'Locale mensa', 'Infermeria di cantiere', 'Parcheggio mezzi', 'Spogliatoi e servizi igienici'];
const mappateMale = locali.filter(v => S.schedaPerVoceVecchia(v) || !S.VOCI_ESCLUSE[v]);
check('locali e aree del cantiere sono esclusi, non schede', mappateMale.length === 0, mappateMale);
check('i materiali (Pittura lavabile) finiscono nella lavorazione (tinteggiature)', S.schedaPerVoceVecchia('Pittura lavabile') === 'tinteggiature');
check('Pozzetti e caditoie non è uno spazio confinato', S.schedaPerVoceVecchia('Pozzetti e caditoie') === 'pavimentazioni-esterne');
check('schedaPerVoceVecchia("Montaggio ponteggio") → ponteggio-montaggio', S.schedaPerVoceVecchia('Montaggio ponteggio') === 'ponteggio-montaggio');
check('schedaPerVoceVecchia(voce sconosciuta) → null', S.schedaPerVoceVecchia('Voce che non esiste') === null);

// Stato di revisione: niente scheda dichiarata "verificata" senza revisore
const statoErr = S.SCHEDE.filter(s => s.revisione && s.revisione.stato === 'verificata' && !s.revisione.da).map(s => s.id);
check('nessuna scheda verificata senza nome del revisore', statoErr.length === 0, statoErr);

console.log(`\n  ${passed} passati, ${failed} falliti\n`);
process.exit(failed ? 1 : 0);
