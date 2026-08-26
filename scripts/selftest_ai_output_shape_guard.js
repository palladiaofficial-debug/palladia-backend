'use strict';
/**
 * BLOCCO 2 — classe "fiducia cieca nell'output IA" (pattern F-066 e famiglia:
 * F-067/068/069/070/077/078/079). Nessuno schema strutturato è imposto sulle
 * risposte JSON-da-prompt di Claude: un documento denso può far restituire un
 * oggetto annidato invece di testo semplice, e se quel valore raggiunge il
 * frontend senza sanificazione, React crasha con l'errore #31 ("Objects are
 * not valid as a React child").
 *
 * F-086 (BLOCCO 2 di questo giro di blindatura): services/ladiaDocumentSearch.js
 * (tool Ladia `leggi_documento_pdf`) aveva lo stesso identico pattern di
 * F-066 ma non era stato coperto dallo sweep originale (che aveva cercato
 * `JSON.parse(match[0])` solo dentro routes/v1/*.js) — `citazione` viene
 * renderizzata direttamente come figlio React in ladiaChatCards.tsx (tipizzata
 * string|null solo lato TypeScript, nessuna garanzia a runtime).
 */
require('dotenv').config();
const assert = require('assert');
const { parseClaudeJson } = require('../services/ladiaDocumentSearch');
const { flattenToText, sanitizeLabelReasonList } = require('../lib/ocrSanitize');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('[ai-output-shape-guard] parseClaudeJson (services/ladiaDocumentSearch.js) — F-086');

check('risposta stringa normale passa invariata', () => {
  const out = parseClaudeJson('{"risposta":"Il DURC scade il 12/03/2027.","citazione":"validità 12/03/2027","pagina":2}');
  assert.strictEqual(out.risposta, 'Il DURC scade il 12/03/2027.');
  assert.strictEqual(out.citazione, 'validità 12/03/2027');
  assert.strictEqual(out.pagina, 2);
});

check('citazione come oggetto annidato viene appiattita a stringa, mai passata come oggetto (F-086)', () => {
  const raw = JSON.stringify({
    risposta: 'vedi dettagli',
    citazione: { testo: 'validità 12/03/2027', nota: 'pagina 2 in basso' },
    pagina: 2,
  });
  const out = parseClaudeJson(raw);
  assert.strictEqual(typeof out.citazione, 'string', 'citazione deve essere sempre string|null, mai un oggetto — altrimenti crash React #31 in ladiaChatCards.tsx');
  assert.ok(out.citazione.includes('validità 12/03/2027'));
});

check('risposta come array annidato viene appiattita a stringa', () => {
  const raw = JSON.stringify({ risposta: ['punto 1', 'punto 2'], citazione: null, pagina: null });
  const out = parseClaudeJson(raw);
  assert.strictEqual(typeof out.risposta, 'string');
  assert.ok(out.risposta.includes('punto 1'));
});

check('JSON malformato non crasha, fallback su testo grezzo', () => {
  const out = parseClaudeJson('non è JSON valido, solo testo libero');
  assert.strictEqual(out.risposta, 'non è JSON valido, solo testo libero');
  assert.strictEqual(out.citazione, null);
});

console.log('[ai-output-shape-guard] flattenToText/sanitizeLabelReasonList (lib/ocrSanitize.js) — copertura esistente F-066/067');

check('flattenToText su oggetto annidato profondo non lancia mai e non ritorna un oggetto', () => {
  const out = flattenToText({ a: { b: { c: 'x' } }, d: [1, 2, { e: 'y' }] });
  assert.strictEqual(typeof out, 'string');
});

check('sanitizeLabelReasonList scarta voci senza label e appiattisce reason oggetto', () => {
  const out = sanitizeLabelReasonList([{ label: 'DPI mancanti', reason: { dettaglio: 'nessun casco in cantiere' } }, { reason: 'senza label, va scartata' }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(typeof out[0].reason, 'string');
});

console.log(`[ai-output-shape-guard] OK — ${passed}/${passed} verdi`);
