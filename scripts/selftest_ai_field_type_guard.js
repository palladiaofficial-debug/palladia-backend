#!/usr/bin/env node
/**
 * scripts/selftest_ai_field_type_guard.js
 *
 * Regressione per F-077/F-078/F-079 (AUDIT.md): stessa classe di bug di
 * F-066/067/069/070 (JSON dell'IA senza schema imposto, un campo atteso come
 * stringa arriva come oggetto annidato) su tre call-site non ancora
 * sanificati, trovati con uno sweep sistematico su tutti i punti che
 * chiamano messages.create() nel repo, invece di aspettare che crashassero
 * uno alla volta come F-066→F-070.
 * Test puro, nessuna rete/DB — verifica le funzioni di guardia in isolamento.
 */
'use strict';
require('dotenv').config();
const { sanitizeExpenseFields } = require('../lib/expenseOcr');
const { normalizeOfferItems } = require('../lib/prezzarioOfferSanitize');
const { normalizeAnalysis } = require('../services/ladiaDocumentProcessor');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function main() {
  console.log('\nPalladia regression — F-077/078/079: campi IA non tipizzati, sanificati prima di rispondere o usarli\n');

  // ── F-077 — lib/expenseOcr.js: /expenses/scan ──────────────────────────────
  const expenseCrash = {
    amount: 125.5,
    description: 'Materiale edile',
    supplier: { ragione_sociale: 'Edilizia Rossi Srl', piva: '01234567890', indirizzo: 'Via Roma 1, Torino' },
    invoice_number: 42, // numero invece di stringa — altro caso limite reale
    expense_date: '2026-08-20',
    category: 'materiali',
    payment_method: null,
  };
  const sanitizedExpense = sanitizeExpenseFields(expenseCrash);
  check('amount (numero) resta numero, non stringa', sanitizedExpense.amount === 125.5, sanitizedExpense.amount);
  check('supplier (oggetto annidato) scartato a null — mai un oggetto vivo che crasherebbe come figlio React (F-066)', sanitizedExpense.supplier === null, sanitizedExpense.supplier);
  check('invoice_number (numero) scartato a null — il campo atteso è testo libero', sanitizedExpense.invoice_number === null, sanitizedExpense.invoice_number);
  check('description (stringa valida) invariata', sanitizedExpense.description === 'Materiale edile', sanitizedExpense.description);
  check('payment_method null resta null', sanitizedExpense.payment_method === null, sanitizedExpense.payment_method);
  const anyExpenseObj = Object.values(sanitizedExpense).some(v => v !== null && typeof v === 'object');
  check('nessun valore sanificato è un oggetto/array (invariante generale)', !anyExpenseObj, sanitizedExpense);
  check('input non valido (null) gestito senza eccezioni', JSON.stringify(sanitizeExpenseFields(null)) === '{}');

  // ── F-078 — lib/prezzarioOfferSanitize.js: /prezzario/parse-offerta ────────
  let threwOnRawTrim = false;
  try { ({ descrizione: { nome: 'Cemento', specifiche: 'sacco 25kg' } }).descrizione.trim(); }
  catch { threwOnRawTrim = true; }
  check('conferma il meccanismo del crash: .trim() su descrizione grezza (oggetto) lancia TypeError — è il 500 PARSE_FAILED osservato', threwOnRawTrim);

  const offerCrash = {
    fornitore: { nome: 'Edil Sud Srl', piva: '09876543210' }, // oggetto invece di stringa
    data_offerta: '2026-08-15',
    items: [
      { descrizione: { nome: 'Cemento', specifiche: 'sacco 25kg' }, um: 'sacco', prezzo: 8.5, categoria: 'Materiali' },
      { descrizione: 'Mattoni forati 8x12x25', um: 'pz', prezzo: 0.45, categoria: 'Materiali', fornitore: 'Fornitore Riga' },
      { descrizione: '', prezzo: 10, categoria: 'Altro' }, // scartata: descrizione vuota
    ],
  };
  const normalizedOffer = normalizeOfferItems(offerCrash);
  check('nessuna eccezione lanciata (prima: TypeError su .trim())', Array.isArray(normalizedOffer.items));
  check('fornitore globale (oggetto) scartato a null, non passato intatto al frontend', normalizedOffer.fornitore === null, normalizedOffer.fornitore);
  check(
    'solo 1 voce valida sopravvive: quella con descrizione-oggetto e quella senza descrizione sono scartate, non passate al frontend con un campo rotto',
    normalizedOffer.items.length === 1, normalizedOffer.items
  );
  check('la voce sopravvissuta ha il fornitore di riga preservato', normalizedOffer.items[0].fornitore === 'Fornitore Riga', normalizedOffer.items[0].fornitore);
  const anyOfferObj = normalizedOffer.items.some(it => Object.values(it).some(v => v !== null && typeof v === 'object'));
  check('nessun campo voce è un oggetto/array (invariante generale)', !anyOfferObj, normalizedOffer.items);

  // ── F-079 — services/ladiaDocumentProcessor.js: analyzePdf (Telegram) ──────
  const docCrash = {
    document_type: 'contratto',
    summary: { intro: 'Contratto di appalto', parti: ['Impresa A', 'Impresa B'] }, // oggetto invece di stringa
    key_sections: [
      { titolo: 'Oggetto', contenuto: { testo: 'Lavori di ristrutturazione', pagina: 3 } }, // contenuto-oggetto
      { titolo: 'Penali', contenuto: 'Ritardo: 0.5% al giorno' },
    ],
    extracted_text: 12345, // numero invece di stringa — altro caso limite
  };
  let threwOnRawSlice = false;
  try { docCrash.summary.slice(0, 10); } catch { threwOnRawSlice = true; }
  check('conferma il meccanismo del crash: .slice() su summary grezzo (oggetto) lancia TypeError', threwOnRawSlice);

  const normalizedDoc = normalizeAnalysis(docCrash);
  check('summary (oggetto) appiattito a stringa vuota, nessuna eccezione', normalizedDoc.summary === '', normalizedDoc.summary);
  check('extracted_text (numero) appiattito a stringa vuota', normalizedDoc.extracted_text === '', normalizedDoc.extracted_text);
  check('key_sections[0].contenuto (oggetto) diventa stringa vuota, non un oggetto', normalizedDoc.key_sections[0].contenuto === '', normalizedDoc.key_sections[0].contenuto);
  check('key_sections[1] (già a posto) resta invariata', normalizedDoc.key_sections[1].contenuto === 'Ritardo: 0.5% al giorno', normalizedDoc.key_sections[1]);
  check('document_type validato contro whitelist', normalizedDoc.document_type === 'contratto', normalizedDoc.document_type);
  check('input non valido gestito senza eccezioni', normalizeAnalysis(null).summary === '');

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
