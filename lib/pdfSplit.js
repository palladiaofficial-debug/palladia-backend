'use strict';
/**
 * lib/pdfSplit.js
 * Ispezione (corrotto/protetto da password) e split per intervallo di pagine
 * di un PDF — usato dall'Importazione Intelligente per rilevare PDF con più
 * documenti scansionati insieme e per scartare file illeggibili prima di
 * spendere una chiamata Claude.
 */

const { PDFDocument } = require('pdf-lib');

/**
 * Carica la struttura del PDF senza decifrarne il contenuto.
 * Ritorna { ok:true, encrypted:false, pageCount } se apribile,
 * { ok:true, encrypted:true, pageCount:null } se protetto da password,
 * { ok:false, error } se corrotto/non un PDF valido.
 */
async function inspectPdf(buffer) {
  try {
    const doc = await PDFDocument.load(buffer);
    return { ok: true, encrypted: false, pageCount: doc.getPageCount() };
  } catch (err) {
    if (/encrypt/i.test(err.message)) {
      return { ok: true, encrypted: true, pageCount: null };
    }
    return { ok: false, encrypted: false, error: err.message };
  }
}

/**
 * Estrae le pagine [startPage, endPage] (1-based, inclusive) in un nuovo
 * buffer PDF indipendente.
 */
async function extractPdfPages(buffer, startPage, endPage) {
  const src = await PDFDocument.load(buffer);
  const out = await PDFDocument.create();
  const indices = [];
  for (let p = startPage; p <= endPage; p++) indices.push(p - 1);
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return Buffer.from(await out.save());
}

module.exports = { inspectPdf, extractPdfPages };
