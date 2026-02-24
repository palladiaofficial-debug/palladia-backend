'use strict';

/**
 * PDF Renderer — Puppeteer (single-stage, no post-processing)
 *
 * Architettura header/footer v9 — DOM-based (position:fixed in CSS):
 *   - displayHeaderFooter: FALSE  → nessun template Puppeteer, zero overlay.
 *   - margin: 0 su tutti i lati  → i margini li gestisce il CSS (.doc padding).
 *   - .doc { padding: 22mm 16mm 20mm 16mm } → spazio per H/F e margini laterali.
 *   - Numerazione: CSS counter(page) per pagina corrente +
 *                  _injectTotalPages() per il totale (pre-PDF, un solo render).
 * Nessun pdf-lib, nessuna manipolazione post-rendering.
 */

let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

// PDF_DEBUG=true → report overflow elementi fuori safe area (max 10 righe).
// Default false — nessun spam Railway.
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

// ── Costruisce le opzioni PDF per page.pdf() ──────────────────────────────────
//
// Tutti i margini a 0: il documento si auto-margina via CSS.
//   .doc { padding: 22mm 16mm 20mm 16mm } → spazio per H/F CSS + margini testo.
//   .print-header { position:fixed; top:0; height:10mm; padding:0 16mm }
//   .print-footer { position:fixed; bottom:0; height:9mm;  padding:0 16mm }
// displayHeaderFooter:false → zero overlay da Puppeteer.
function makePdfOpts() {
  return {
    format:              'A4',
    printBackground:     true,
    displayHeaderFooter: false,
    margin: {
      top:    '0mm',
      bottom: '0mm',
      left:   '0mm',
      right:  '0mm',
    },
  };
}

// ── Inietta il numero totale di pagine PRIMA del render ───────────────────────
// Calcola le pagine dall'altezza del documento (viewport = A4 ≈ 1123px).
// Riempi tutti gli elementi .js-total-pages con il conteggio calcolato.
// Questo evita un secondo render ed è sufficientemente preciso (±1 pag.).
async function _injectTotalPages(page) {
  const total = await page.evaluate(() => {
    // Il viewport è impostato a 794×1123 (≈ A4 a 96dpi).
    const a4px = window.innerHeight || 1123;
    return Math.max(1, Math.ceil(document.documentElement.scrollHeight / a4px));
  });
  await page.evaluate((n) => {
    document.querySelectorAll('.js-total-pages').forEach(el => { el.textContent = n; });
  }, total);
}

// ── Debug overflow (solo se PDF_DEBUG=true) ───────────────────────────────────
// Logga al massimo 10 selettori che sforano safeL/safeR — nessun spam.
async function _debugOverflow(page) {
  const results = await page.evaluate(() => {
    const safeL = 60.5; // ~16mm a 96dpi
    const safeR = 733.5; // A4 793.7 - 60.2
    const hits = {};
    document.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const tag = el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ')[0] : '');
      if (r.left < safeL - 2 || r.right > safeR + 2) {
        hits[tag] = (hits[tag] || 0) + 1;
      }
    });
    return hits;
  });
  const entries = Object.entries(results).slice(0, 10);
  if (entries.length) {
    console.warn('[PDF_DEBUG] overflow elements (selector: count):');
    entries.forEach(([sel, n]) => console.warn(`  ${sel}: ${n}`));
  } else {
    console.log('[PDF_DEBUG] no overflow detected — all elements within safe area');
  }
}

// ── renderHtmlToPdf (browser monouso) ─────────────────────────────────────────
async function renderHtmlToPdf(html, opts = {}) {
  if (!puppeteer) throw new Error(
    'Puppeteer non installato. Esegui: npm install puppeteer\n' +
    'Nota: la prima installazione scarica Chromium (~170 MB).'
  );
  const browser = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluateHandle('document.fonts.ready');
    await _injectTotalPages(page);
    if (PDF_DEBUG) await _debugOverflow(page);
    return await page.pdf(makePdfOpts());
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
          console.warn('[Puppeteer] browser disconnected — relaunch on next request');
          this._browser = null;
        });
        return b;
      })
      .catch(err => {
        console.error('[Puppeteer] launch failed:', err.message);
        this._launching = null;
        throw err;
      });

    return this._launching;
  }

  async render(html, opts = {}) {
    if (!puppeteer) throw new Error('Puppeteer non installato. Esegui: npm install puppeteer');
    const browser = await this._getBrowser();
    const page    = await browser.newPage();
    try {
      await page.setViewport({ width: 794, height: 1123 });
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.evaluateHandle('document.fonts.ready');
      await _injectTotalPages(page);
      if (PDF_DEBUG) await _debugOverflow(page);
      return await page.pdf(makePdfOpts());
    } finally {
      await page.close();
    }
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
