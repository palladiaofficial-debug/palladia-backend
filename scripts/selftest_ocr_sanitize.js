#!/usr/bin/env node
/**
 * scripts/selftest_ocr_sanitize.js
 *
 * Regressione per F-066/F-067 (AUDIT.md): lib/ocrSanitize.js — condivisa da
 * tutte le rotte che chiedono all'IA un JSON via prompt testuale (nessuno
 * schema imposto): routes/v1/equipment.js (F-066, il primo trovato, un
 * oggetto annidato in note_extra crashava /risorse — errore React #31,
 * riprodotto dal vivo contro l'endpoint reale in produzione con un PDF
 * sintetico), routes/v1/ocrExpiry.js e routes/v1/baracca.js (F-067, stesso
 * pattern trovato controllando sistematicamente gli altri endpoint OCR dopo
 * F-066, non ancora osservato in produzione ma stessa causa strutturale).
 * Test puro, nessuna rete/DB — verifica lib/ocrSanitize.js in isolamento.
 */
'use strict';
const assert = require('assert');
const { sanitizeExtractedFields, sanitizeLabelReasonList, flattenToText } = require('../lib/ocrSanitize');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function main() {
  console.log('\nPalladia regression — F-066/F-067 OCR: campo annidato dell\'IA sanificato prima di rispondere\n');

  // Forma esatta osservata riproducendo dal vivo contro l'endpoint reale
  // (POST /api/v1/equipment/ocr) con un PDF sintetico di carta di
  // circolazione molto densa.
  const crashShape = {
    targa: null,
    marca: 'IVECO',
    modello: 'Daily 35C15',
    anno_immatricolazione: 2019,
    note_extra: {
      numero_carta_circolazione: 'PD1234567X',
      tipo_veicolo: 'N1',
      lunghezza: '5998 mm',
      pneumatici_anteriori: '225/75 R16C',
      pneumatici_posteriori: '225/75 R16C',
      tipo_cambio: 'Manuale 6 marce',
    },
  };

  const sanitized = sanitizeExtractedFields(crashShape);

  check(
    'note_extra non è più un oggetto (causava "Objects are not valid as a React child")',
    typeof sanitized.note_extra !== 'object',
    sanitized.note_extra
  );
  check('note_extra è una stringa leggibile', typeof sanitized.note_extra === 'string', sanitized.note_extra);
  check(
    'nessuna informazione persa: i dati originali restano leggibili nel testo appiattito',
    typeof sanitized.note_extra === 'string' && sanitized.note_extra.includes('PD1234567X') && sanitized.note_extra.includes('tipo_cambio'),
    sanitized.note_extra
  );

  // Campi scalari normali: nessuna regressione sul percorso comune.
  check('marca (stringa) invariata', sanitized.marca === 'IVECO', sanitized.marca);
  check('targa null resta null', sanitized.targa === null, sanitized.targa);
  check('anno_immatricolazione (numero) diventa stringa, mai un oggetto', sanitized.anno_immatricolazione === '2019', sanitized.anno_immatricolazione);

  // Nessun campo del risultato sanificato può mai essere un oggetto o un
  // array — è l'invariante che previene il crash, non solo il caso singolo.
  const anyNonScalar = Object.values(sanitized).some((v) => v !== null && typeof v === 'object');
  check('nessun valore nel risultato sanificato è un oggetto/array (invariante generale)', !anyNonScalar, sanitized);

  // Array annidato — stesso trattamento difensivo.
  const withArray = sanitizeExtractedFields({ note_extra: ['a', 'b', 'c'] });
  check('un array viene appiattito a stringa, non lasciato com\'è', typeof withArray.note_extra === 'string', withArray.note_extra);

  // Input non valido — non deve esplodere.
  check('input null gestito senza eccezioni', JSON.stringify(sanitizeExtractedFields(null)) === '{}');

  // ── routes/v1/ocrExpiry.js — stesso pattern applicato campo per campo ──────
  check(
    'flattenToText: un oggetto annidato in un campo data diventa testo leggibile, non un oggetto',
    flattenToText({ raw: 'scade 10/2027', note: 'timbro poco leggibile' }) === 'raw: scade 10/2027; note: timbro poco leggibile'
  );
  check('flattenToText: stringa passa invariata', flattenToText('2027-10-01') === '2027-10-01');
  check('flattenToText: null resta null', flattenToText(null) === null);

  // ── routes/v1/baracca.js — lista di suggerimenti {label, reason} ──────────
  const suggCrash = [
    { label: 'Piano di scavo', reason: { normativa: 'D.Lgs 81/08 art. 118', dettaglio: { obbligatorio: true } } },
    { label: 'Cartello di cantiere', reason: 'Dati impresa e CSE visibili' },
  ];
  const sanitizedSugg = sanitizeLabelReasonList(suggCrash);
  check('sanitizeLabelReasonList: nessuna voce ha reason come oggetto', sanitizedSugg.every(s => typeof s.reason !== 'object'), sanitizedSugg);
  check('sanitizeLabelReasonList: la seconda voce (già a posto) non cambia', sanitizedSugg[1].reason === 'Dati impresa e CSE visibili', sanitizedSugg[1]);
  check('sanitizeLabelReasonList: input non-array gestito senza eccezioni', JSON.stringify(sanitizeLabelReasonList(null)) === '[]');
  check('sanitizeLabelReasonList: voci senza label scartate', sanitizeLabelReasonList([{ reason: 'x' }]).length === 0);

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
