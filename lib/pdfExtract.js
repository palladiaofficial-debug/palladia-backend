'use strict';
/**
 * lib/pdfExtract.js
 * Estrae testo strutturato da un buffer PDF usando pdfjs-dist legacy (ESM).
 * Ricostruisce le righe raggruppando gli item per coordinata Y (±LINE_TOL punti).
 * Mantiene l'ordine visivo: Y decrescente (alto→basso), X crescente (sinistra→destra).
 */

const LINE_TOL = 3; // punti PDF: item con |ΔY| ≤ 3 sono sulla stessa riga

// pdfjs-dist (build "legacy", senza un vero Worker thread in Node) non è
// sicura sotto chiamate concorrenti: due getDocument() in corso insieme
// possono far fallire l'un l'altro con "Invalid page request" anche su
// pagine perfettamente valide — riprodotto in modo deterministico (F-052,
// AUDIT.md) lanciando 3 estrazioni in parallelo, stesso grado di
// concorrenza di services/smartImportPipeline.js (CONCURRENCY=3). Una coda
// globale che serializza le chiamate elimina la corsa critica: il costo in
// latenza è minimo (l'estrazione è locale, niente rete/AI) rispetto al
// rischio di perdere documenti reali per un errore intermittente.
let _pdfExtractQueue = Promise.resolve();
function withPdfExtractQueue(fn) {
  const result = _pdfExtractQueue.then(fn, fn);
  _pdfExtractQueue = result.catch(() => {});
  return result;
}

async function extractPdfText(buffer, opts = {}) {
  return withPdfExtractQueue(() => extractPdfTextUnsafe(buffer, opts));
}

async function extractPdfTextUnsafe(buffer, { maxPages = 80, minChars = 20 } = {}) {
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
