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

// PDF_DEBUG=true → logs dettagliati + outline safe area nel diag endpoint.
// In produzione lasciare false (default) per non spammare i log Railway.
const PDF_DEBUG = process.env.PDF_DEBUG === 'true';

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
 * padding: 0 16mm → allineato alla griglia .page (stessa colonna del testo).
 */
function buildHeaderTemplate(docTitle) {
  return `<div style="box-sizing:border-box;width:100%;height:10mm;display:flex;align-items:center;padding:0 16mm;border-bottom:0.4pt solid #DDDDDD;font-family:Arial,Helvetica,sans-serif;font-size:0;line-height:1.1;">
  <span style="font-size:9px;font-weight:bold;color:#2C2C2C;letter-spacing:0.5pt;line-height:1.1;flex:0 0 auto;">PALLADIA</span>
  <span style="font-size:9px;color:#AAAAAA;line-height:1.1;flex:1;text-align:right;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">${escT(docTitle)}</span>
</div>`;
}

/**
 * Template piè di pagina — thin bar ~9mm.
 *
 * height:9mm; il resto del margine bottom (20-9=11mm) è respiro.
 * padding: 0 16mm → allineato alla griglia .page (stessa colonna del testo).
 * pageNumber / totalPages: iniettati da Chrome — font-size esplicito obbligatorio.
 */
function buildFooterTemplate(revision) {
  const rev = escT(String(revision || 1));
  return `<div style="box-sizing:border-box;width:100%;height:9mm;display:flex;align-items:center;padding:0 16mm;border-top:0.4pt solid #DDDDDD;font-family:Arial,Helvetica,sans-serif;font-size:0;line-height:1.1;">
  <span style="font-size:9px;color:#BBBBBB;line-height:1.1;flex:1;">D.Lgs 81/2008 e s.m.i.</span>
  <span style="font-size:9px;color:#444444;font-weight:bold;line-height:1.1;flex:0 0 auto;">Pagina&#160;<span class="pageNumber" style="font-size:9px;line-height:1.1;"></span>&#160;/&#160;<span class="totalPages" style="font-size:9px;line-height:1.1;"></span></span>
  <span style="font-size:9px;color:#BBBBBB;line-height:1.1;flex:1;text-align:right;">Rev.&#160;${rev}</span>
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
// Strategia margini definitiva (unica sorgente di verità):
//   Verticale  → Puppeteer: top:22mm (header 10mm + 12mm respiro)
//                            bottom:20mm (footer 9mm + 11mm respiro)
//   Orizzontale → CSS: .page { padding: 0 16mm } gestisce il laterale nel DOM.
//                 Puppeteer left/right: '0mm' — nessun doppio margine.
//
// Header/footer template usano padding:0 16mm per allinearsi alla griglia .page.
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
      left:   '0mm',
      right:  '0mm',
    },
  };
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
    if (PDF_DEBUG) await _debugOverflow(page);
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
      if (PDF_DEBUG) await _debugOverflow(page);
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
