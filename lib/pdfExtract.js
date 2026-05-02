'use strict';
/**
 * lib/pdfExtract.js
 * Estrae testo plain da un buffer PDF usando pdfjs-dist legacy (ESM).
 * Usa dynamic import perché pdfjs-dist v5 non ha più build CJS.
 */

async function extractPdfText(buffer, { maxPages = 80, minChars = 20 } = {}) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data     = new Uint8Array(buffer);
  const doc      = await getDocument({ data, disableFontFace: true, verbosity: 0 }).promise;
  const total    = doc.numPages;
  const numPages = Math.min(total, maxPages);
  const pages    = [];

  for (let i = 1; i <= numPages; i++) {
    const page    = await doc.getPage(i);
    const content = await page.getTextContent();
    const text    = content.items.map(item => item.str).join(' ');
    if (text.trim().length > minChars) pages.push(`--- Pagina ${i} ---\n${text}`);
  }

  return { text: pages.join('\n\n'), numPages: total };
}

module.exports = { extractPdfText };
