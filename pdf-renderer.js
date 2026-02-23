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
 * Template intestazione — thin bar ~10mm.
 *
 * height:10mm = barra visiva; il resto del margine top (22-10=12mm) è
 * spazio bianco di respiro tra barra e contenuto.
 * CRITICO Puppeteer: font-size:0 sul container, esplicito su ogni span.
 * padding orizzontale: 4mm (barra leggermente rientrata dal bordo carta).
 */
function buildHeaderTemplate(docTitle) {
  return `<div style="box-sizing:border-box;width:100%;height:10mm;display:flex;align-items:center;padding:0 4mm;border-bottom:0.4pt solid #DDDDDD;font-family:Arial,Helvetica,sans-serif;font-size:0;line-height:1;">
  <span style="font-size:9px;font-weight:bold;color:#2C2C2C;letter-spacing:0.5pt;line-height:1;flex:0 0 auto;">PALLADIA</span>
  <span style="font-size:9px;color:#AAAAAA;line-height:1;flex:1;text-align:right;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${escT(docTitle)}</span>
</div>`;
}

/**
 * Template piè di pagina — thin bar ~9mm.
 *
 * height:9mm; il resto del margine bottom (20-9=11mm) è respiro.
 * pageNumber / totalPages: iniettati da Chrome — font-size esplicito obbligatorio.
 */
function buildFooterTemplate(revision) {
  const rev = escT(String(revision || 1));
  return `<div style="box-sizing:border-box;width:100%;height:9mm;display:flex;align-items:center;padding:0 4mm;border-top:0.4pt solid #DDDDDD;font-family:Arial,Helvetica,sans-serif;font-size:0;line-height:1;">
  <span style="font-size:9px;color:#BBBBBB;line-height:1;flex:1;">D.Lgs 81/2008 e s.m.i.</span>
  <span style="font-size:9px;color:#444444;font-weight:bold;line-height:1;flex:0 0 auto;">Pagina&#160;<span class="pageNumber" style="font-size:9px;line-height:1;"></span>&#160;/&#160;<span class="totalPages" style="font-size:9px;line-height:1;"></span></span>
  <span style="font-size:9px;color:#BBBBBB;line-height:1;flex:1;text-align:right;">Rev.&#160;${rev}</span>
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
// Strategia margini definitiva:
//   top:22mm   → header bar 10mm + 12mm respiro sopra il contenuto
//   bottom:20mm → footer bar  9mm + 11mm respiro sotto il contenuto
//   left/right:0  → il body { padding:0 16mm } gestisce il laterale nel DOM
//
// Perché funziona su TUTTE le pagine:
//   - Puppeteer top/bottom si applicano per-pagina (Chrome riserva quel buffer)
//   - body padding si applica a tutta la larghezza del body (ogni pagina)
function makePdfOpts(opts) {
  return {
    format:              'A4',
    printBackground:     true,
    preferCSSPageSize:   true,
    displayHeaderFooter: true,
    headerTemplate:      buildHeaderTemplate(opts.docTitle || ''),
    footerTemplate:      buildFooterTemplate(opts.revision || opts.rev || 1),
    margin: {
      top:    '22mm',
      bottom: '20mm',
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
