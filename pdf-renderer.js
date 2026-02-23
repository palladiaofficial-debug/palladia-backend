'use strict';

/**
 * PDF Renderer — Puppeteer (single-stage, no post-processing)
 *
 * Margini gestiti da Puppeteer via page.pdf({ margin }).
 * CSS usa @page { margin: 0 } per evitare doppi margini.
 * Header/footer tramite displayHeaderFooter nativo di Chrome:
 *   - <span class="pageNumber">  → numero pagina corrente
 *   - <span class="totalPages">  → totale pagine
 * Nessun pdf-lib, nessuna manipolazione post-rendering.
 *
 * Richiede: npm install puppeteer
 */

let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

// ── HTML escape per testo nei template ────────────────────────────────────────
function escT(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Template intestazione.
 *
 * Margine Puppeteer top = 28mm → questo template occupa 28mm.
 * Il testo è allineato al FONDO del template (vicino al contenuto).
 * padding: 0 16mm allinea il testo al body padding orizzontale del POS.
 * CRITICO: font-size:0 sul container, font-size esplicito su ogni span.
 */
function buildHeaderTemplate(docTitle) {
  return `<div style="box-sizing:border-box;width:100%;height:28mm;display:flex;align-items:flex-end;padding:0 16mm 5px 16mm;border-bottom:0.5pt solid #DDDDDD;font-family:Arial,Helvetica,sans-serif;font-size:0;">
  <span style="font-size:8px;font-weight:bold;color:#2C2C2C;letter-spacing:0.5pt;flex:0 0 auto;">PALLADIA</span>
  <span style="font-size:8px;color:#999999;flex:1;text-align:right;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${escT(docTitle)}</span>
</div>`;
}

/**
 * Template piè di pagina.
 *
 * Margine Puppeteer bottom = 28mm → template alto 28mm.
 * Il testo è allineato in CIMA (vicino al contenuto).
 * padding: 0 16mm allinea al body padding orizzontale del POS.
 * pageNumber e totalPages: iniettati da Chrome — font-size esplicito obbligatorio.
 */
function buildFooterTemplate(revision) {
  const rev = escT(String(revision || 1));
  return `<div style="box-sizing:border-box;width:100%;height:28mm;display:flex;align-items:flex-start;padding:5px 16mm 0 16mm;border-top:0.5pt solid #DDDDDD;font-family:Arial,Helvetica,sans-serif;font-size:0;">
  <span style="font-size:7.5px;color:#BBBBBB;flex:1;">D.Lgs 81/2008 e s.m.i.</span>
  <span style="font-size:7.5px;color:#444444;font-weight:bold;flex:0 0 auto;">Pagina&#160;<span class="pageNumber" style="font-size:7.5px;"></span>&#160;di&#160;<span class="totalPages" style="font-size:7.5px;"></span></span>
  <span style="font-size:7.5px;color:#BBBBBB;flex:1;text-align:right;">Rev.&#160;${rev}</span>
</div>`;
}

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
// Strategia margini:
//   Verticale (top/bottom): gestito da Puppeteer margin 28mm → spazio per H/F
//     su OGNI pagina del PDF.
//   Orizzontale (left/right): gestito da body { padding: 0 16mm } nel CSS del POS.
//     Puppeteer left/right = 0 → nessun doppio margine laterale.
//
// Risultato: contenuto a left=60px nel DOM (16mm×3.78), nessun overflow laterale.
function makePdfOpts(opts) {
  return {
    format:              'A4',
    printBackground:     true,
    preferCSSPageSize:   true,
    displayHeaderFooter: true,
    headerTemplate:      buildHeaderTemplate(opts.docTitle || ''),
    footerTemplate:      buildFooterTemplate(opts.revision || opts.rev || 1),
    margin: {
      top:    '28mm',
      bottom: '28mm',
      left:   '0',
      right:  '0',
    },
  };
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
    return await page.pdf(makePdfOpts(opts));
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
      return await page.pdf(makePdfOpts(opts));
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
