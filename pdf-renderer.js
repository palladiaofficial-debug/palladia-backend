'use strict';

/**
 * PDF Renderer — Puppeteer + pdf-lib (2-pass per numerazione deterministica)
 *
 * Architettura v10:
 *   - displayHeaderFooter: false  → header/footer nel DOM (position:fixed).
 *   - margin: 0 su tutti i lati  → tutto gestito da .doc { padding:22mm 16mm 20mm 16mm }.
 *   - PASS 1: render → pdf-lib legge getPageCount() → numero pagine reale.
 *   - PASS 2: inject totale in <span class="total-pages"> → re-render definitivo.
 *   - Pagina corrente: CSS counter(page) in .page-num::after (zero JS, 100% affidabile).
 *   - pdf-lib usato SOLO per getPageCount(), mai per disegnare.
 */

let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

let PDFDocument = null;
try { ({ PDFDocument } = require('pdf-lib')); } catch { PDFDocument = null; }

// PDF_DEBUG=true → report overflow orizzontale (max 10 righe). Default: false.
const PDF_DEBUG = process.env.PDF_DEBUG === 'true';

// ── Args Chromium ─────────────────────────────────────────────────────────────
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--font-render-hinting=none',
];

// ── Opzioni PDF fisse ─────────────────────────────────────────────────────────
// Tutti i margini a 0: il CSS gestisce tutto via .doc padding e position:fixed.
function makePdfOpts() {
  return {
    format:              'A4',
    printBackground:     true,
    displayHeaderFooter: false,
    margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' },
  };
}

// ── Legge il numero reale di pagine dal buffer PDF (pdf-lib) ──────────────────
async function _getPageCount(pdfBuf) {
  if (!PDFDocument) return null;
  try {
    const doc = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch (e) {
    console.warn('[PDF 2-pass] pdf-lib getPageCount failed:', e.message);
    return null;
  }
}

// ── Sostituisce il placeholder del totale nell'HTML (server-side) ─────────────
// Il placeholder è: <span class="total-pages">—</span>
// Dopo il replace diventa: <span class="total-pages">N</span>
function _injectTotal(html, n) {
  return html.replace(
    /<span class="total-pages">[^<]*<\/span>/,
    `<span class="total-pages">${n}</span>`
  );
}

// ── Render singolo su un browser già aperto ───────────────────────────────────
async function _renderOnBrowser(browser, html, doDebug) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 794, height: 1123 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluateHandle('document.fonts.ready');
    if (doDebug) await _debugOverflow(page);
    return await page.pdf(makePdfOpts());
  } finally {
    await page.close();
  }
}

// ── 2-pass render ─────────────────────────────────────────────────────────────
// Pass 1: render con placeholder "—" → conta pagine reali via pdf-lib.
// Pass 2: inject totale reale → render definitivo.
// Se pdf-lib non disponibile: restituisce Pass 1 (fallback sicuro).
async function _twoPassRender(browser, html) {
  // — PASS 1 —
  const pdf1 = await _renderOnBrowser(browser, html, false);

  // — LEGGI PAGINE —
  const total = await _getPageCount(pdf1);
  if (!total) {
    if (PDF_DEBUG) console.warn('[PDF 2-pass] fallback: pdf-lib non disponibile, restituisco Pass 1');
    return pdf1;
  }

  // — PASS 2 —
  const html2 = _injectTotal(html, total);
  const pdf2  = await _renderOnBrowser(browser, html2, PDF_DEBUG);

  if (PDF_DEBUG) console.log(`[PDF 2-pass] completato: ${total} pagine`);
  return pdf2;
}

// ── Debug overflow (solo se PDF_DEBUG=true) ───────────────────────────────────
// Confronta clientWidth vs scrollWidth su .doc; logga top-10 selettori sforanti.
async function _debugOverflow(page) {
  const hits = await page.evaluate(() => {
    const doc = document.querySelector('.doc');
    const maxW = doc ? doc.clientWidth : document.documentElement.clientWidth;
    const results = {};
    document.querySelectorAll('*').forEach(el => {
      if (el.scrollWidth > maxW + 2) {
        const key = el.tagName.toLowerCase() +
          (el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/)[0] : '');
        results[key] = (results[key] || 0) + 1;
      }
    });
    return results;
  });
  const entries = Object.entries(hits).slice(0, 10);
  if (entries.length) {
    console.warn('[PDF_DEBUG] overflow laterale (selettore: count):');
    entries.forEach(([s, n]) => console.warn(`  ${s}: ${n}`));
  } else {
    console.log('[PDF_DEBUG] nessun overflow — tutti gli elementi dentro .doc');
  }
}

// ── renderHtmlToPdf (browser monouso — test/fallback) ─────────────────────────
async function renderHtmlToPdf(html, opts = {}) {
  if (!puppeteer) throw new Error(
    'Puppeteer non installato. Esegui: npm install puppeteer'
  );
  const browser = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    return await _twoPassRender(browser, html);
  } finally {
    await browser.close();
  }
}

// ── PdfRendererPool (browser condiviso in produzione) ─────────────────────────
class PdfRendererPool {
  constructor() {
    this._browser   = null;
    this._launching = null;
  }

  async _getBrowser() {
    if (this._browser) {
      try { await this._browser.version(); return this._browser; }
      catch { this._browser = null; }
    }
    if (this._launching) return this._launching;

    this._launching = puppeteer.launch({ headless: true, args: LAUNCH_ARGS })
      .then(b => {
        this._browser   = b;
        this._launching = null;
        b.on('disconnected', () => {
          console.warn('[Puppeteer] browser disconnesso — riavvio al prossimo render');
          this._browser = null;
        });
        return b;
      })
      .catch(err => {
        console.error('[Puppeteer] launch fallito:', err.message);
        this._launching = null;
        throw err;
      });

    return this._launching;
  }

  // render() = 2-pass sul browser condiviso (Pass 1 + Pass 2 sulla stessa istanza).
  async render(html, opts = {}) {
    if (!puppeteer) throw new Error('Puppeteer non installato. Esegui: npm install puppeteer');
    const browser = await this._getBrowser();
    return await _twoPassRender(browser, html);
  }

  async close() {
    if (this._browser) {
      await this._browser.close();
      this._browser = null;
    }
  }
}

const rendererPool = new PdfRendererPool();
module.exports = { renderHtmlToPdf, rendererPool };
