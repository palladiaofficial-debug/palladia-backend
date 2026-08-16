#!/usr/bin/env node
// Riproduzione LOCALE, zero costo (nessuna chiamata AI) del bug "Invalid page
// request" trovato in F-052: ipotesi = extractPdfText (pdfjs-dist) non è
// sicura sotto esecuzione concorrente (smartImportPipeline processa
// CONCURRENCY=3 item in parallelo con Promise.all, ognuno chiama
// extractPdfText sul proprio frammento).
'use strict';
const fs = require('fs');
const { extractPdfPages } = require('../lib/pdfSplit');
const { extractPdfText } = require('../lib/pdfExtract');

const FILE_PATH = 'C:/Users/ricka/Downloads/CI10119@01@AZIENDA.PDF';

// Stessi intervalli di pagina osservati nel batch reale (16 buste paga).
const RANGES = [
  [1, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 10], [11, 12], [13, 14],
  [15, 15], [16, 16], [17, 17], [18, 18], [19, 20], [21, 21], [22, 22], [23, 23], [24, 24],
];

async function extractOne(buffer, start, end) {
  const segBuffer = await extractPdfPages(buffer, start, end);
  const { text, numPages } = await extractPdfText(segBuffer, { maxPages: 30, minChars: 10 });
  return { range: `${start}-${end}`, numPages, textLen: text.length };
}

async function main() {
  const buffer = fs.readFileSync(FILE_PATH);
  console.log('\n=== Sequenziale (baseline, deve sempre funzionare) ===');
  for (const [s, e] of RANGES) {
    try {
      const r = await extractOne(buffer, s, e);
      console.log(`  OK  ${r.range}: numPages=${r.numPages} textLen=${r.textLen}`);
    } catch (err) {
      console.log(`  ERR ${s}-${e}: ${err.message}`);
    }
  }

  console.log('\n=== Concorrente, CONCURRENCY=3 come nella pipeline reale ===');
  for (let i = 0; i < RANGES.length; i += 3) {
    const batch = RANGES.slice(i, i + 3);
    const results = await Promise.allSettled(batch.map(([s, e]) => extractOne(buffer, s, e)));
    results.forEach((res, idx) => {
      const [s, e] = batch[idx];
      if (res.status === 'fulfilled') console.log(`  OK  ${s}-${e}: numPages=${res.value.numPages} textLen=${res.value.textLen}`);
      else console.log(`  ERR ${s}-${e}: ${res.reason.message}`);
    });
  }
}

main().catch(e => { console.error('ERRORE SCRIPT:', e.message); process.exit(1); });
