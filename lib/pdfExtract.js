'use strict';
/**
 * lib/pdfExtract.js
 * Estrae testo strutturato da un buffer PDF usando pdfjs-dist legacy (ESM).
 * Ricostruisce le righe raggruppando gli item per coordinata Y (±LINE_TOL punti).
 * Mantiene l'ordine visivo: Y decrescente (alto→basso), X crescente (sinistra→destra).
 */

const LINE_TOL = 3; // punti PDF: item con |ΔY| ≤ 3 sono sulla stessa riga

async function extractPdfText(buffer, { maxPages = 80, minChars = 20 } = {}) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data  = new Uint8Array(buffer);
  const doc   = await getDocument({ data, disableFontFace: true, verbosity: 0 }).promise;
  const total = doc.numPages;
  const pages = [];

  for (let p = 1; p <= Math.min(total, maxPages); p++) {
    const page    = await doc.getPage(p);
    const content = await page.getTextContent();

    // Raccoglie item con posizione
    const items = content.items
      .filter(it => it.str && it.str.trim())
      .map(it => ({ x: it.transform[4], y: it.transform[5], str: it.str }));

    if (items.length === 0) continue;

    // Ordina: Y decrescente (alto→basso), poi X crescente (sinistra→destra)
    items.sort((a, b) => b.y - a.y || a.x - b.x);

    // Raggruppa in righe: nuova riga se |ΔY| > LINE_TOL
    const lines = [];
    let curLine = [items[0]];
    let curY    = items[0].y;

    for (let i = 1; i < items.length; i++) {
      const it = items[i];
      if (Math.abs(it.y - curY) <= LINE_TOL) {
        curLine.push(it);
      } else {
        curLine.sort((a, b) => a.x - b.x);
        lines.push(curLine.map(c => c.str).join(' ').trim());
        curLine = [it];
        curY    = it.y;
      }
    }
    // ultima riga pendente
    curLine.sort((a, b) => a.x - b.x);
    lines.push(curLine.map(c => c.str).join(' ').trim());

    const text = lines.filter(l => l).join('\n');
    if (text.trim().length > minChars) pages.push(`--- Pagina ${p} ---\n${text}`);
  }

  return { text: pages.join('\n'), numPages: total };
}

module.exports = { extractPdfText };
