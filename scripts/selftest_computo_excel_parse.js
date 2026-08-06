#!/usr/bin/env node
/**
 * scripts/selftest_computo_excel_parse.js
 *
 * Test di regressione per services/computoParser.js:parseExcel dopo il
 * consolidamento xlsx → exceljs (xlsx aveva una vulnerabilità nota senza fix
 * disponibile; exceljs era già in uso in 6 altri file per la scrittura).
 * Genera un vero workbook .xlsx in memoria (nessun file fisso da mantenere)
 * e verifica che il parsing column-aware produca numeri e struttura corretti
 * — nessuna chiamata AI necessaria per questo caso, quindi il test è veloce
 * e non consuma crediti Anthropic.
 *
 * Nessun server/DB richiesto: parseExcel è una funzione pura quando
 * companyId è null (nessuna chiamata a logUsage).
 */
'use strict';
require('dotenv').config();
const ExcelJS = require('exceljs');
const { parseExcel } = require('../services/computoParser');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }

async function buildWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Computo');
  ws.addRow(['Codice', 'Descrizione', 'UM', 'Quantita', 'Prezzo Unitario', 'Importo']);
  ws.addRow(['A', 'SCAVI E FONDAZIONI', '', '', '', '']);
  ws.addRow(['A.1', 'Scavo di sbancamento a sezione ristretta', 'mc', 120.5, 12.30, 1482.15]);
  ws.addRow(['A.2', 'Rinterro con materiale di risulta', 'mc', 45, 8.50, 382.5]);
  ws.addRow(['A.3', 'Trasporto a discarica materiale di risulta', 'mc', 20.25, 15.75, 318.9375]);
  return wb.xlsx.writeBuffer();
}

(async () => {
  console.log('\n=== selftest_computo_excel_parse ===\n');

  const buffer = await buildWorkbook();
  const result = await parseExcel(buffer, null, null);

  const voci = result.voci.filter(v => v.tipo === 'voce');
  if (voci.length === 3) ok('3 voci riconosciute (parsing column-aware, non fallback AI)');
  else fail('3 voci riconosciute', voci.length);

  const categoria = result.voci.find(v => v.tipo === 'categoria');
  if (categoria && categoria.codice === 'A' && categoria.descrizione === 'SCAVI E FONDAZIONI') {
    ok('riga categoria riconosciuta correttamente');
  } else {
    fail('riga categoria riconosciuta correttamente', categoria);
  }

  const a1 = result.voci.find(v => v.codice === 'A.1');
  if (a1 && a1.quantita === 120.5 && a1.prezzo_unitario === 12.3 && Math.abs(a1.importo - 1482.15) < 0.01) {
    ok('numeri della voce A.1 letti correttamente come number (non stringhe formattate)');
  } else {
    fail('numeri della voce A.1 letti correttamente', a1);
  }

  const a3 = result.voci.find(v => v.codice === 'A.3');
  if (a3 && Math.abs(a3.importo - 318.94) < 0.01) {
    ok('arrotondamento a 2 decimali su importo con più cifre (318.9375 → 318.94)');
  } else {
    fail('arrotondamento a 2 decimali', a3);
  }

  const totaleAtteso = 1482.15 + 382.5 + 318.94;
  if (Math.abs(result.totale_contratto - totaleAtteso) < 0.01) {
    ok('totale_contratto calcolato correttamente sulla somma delle voci');
  } else {
    fail('totale_contratto', result.totale_contratto);
  }

  console.log(`\n${passed} passati, ${failed} falliti\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  console.error('Errore imprevisto:', e.message);
  process.exit(1);
});
