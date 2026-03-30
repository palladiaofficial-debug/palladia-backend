'use strict';

/**
 * PDF Renderer — Puppeteer (single-pass, Puppeteer header/footer nativo)
 *
 * Architettura v13 — Puppeteer displayHeaderFooter: true:
 *   - Header/footer via template Puppeteer: NESSUN overlay, NESSUNA posizione fixed.
 *   - margin: { top:'26mm', bottom:'24mm', left:'0mm', right:'0mm' }
 *     Chrome riserva le bande top/bottom per H/F; il contenuto non le invade mai.
 *     Gap header→contenuto: 16mm. Gap contenuto→footer: 15mm.
 *   - Laterali 0mm da Puppeteer: .doc { padding: 0 16mm } allinea body con H/F.
 *   - pageNumber / totalPages: iniettati da Chrome internamente (deterministici).
 *   - Nessun pdf-lib, nessun 2-pass manuale, nessuna stima da scrollHeight.
 *
 * Concorrenza:
 *   - MAX_CONCURRENT_PDF (env, default 2) limita i render paralleli.
 *   - Le richieste in eccesso vengono accodate invece di crashare per OOM.
 *   - PDF_QUEUE_TIMEOUT (env, default 120s) — timeout per una richiesta in coda.
 */

let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

// PDF_DEBUG=true → report overflow (max 10 righe). Default false.
const PDF_DEBUG = process.env.PDF_DEBUG === 'true';

// Massimo render PDF simultanei — protegge dalla memoria di Chromium
const MAX_CONCURRENT_PDF  = parseInt(process.env.MAX_CONCURRENT_PDF  || '2', 10);
const PDF_QUEUE_TIMEOUT_MS = parseInt(process.env.PDF_QUEUE_TIMEOUT   || '120000', 10);

// ── HTML escape per i template Puppeteer ──────────────────────────────────────
function escT(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Header Puppeteer — barra 10mm.
 * padding: 0 16mm → allineato al .doc { padding: 0 16mm } del body.
 * font-size:0 sul container → ogni span ha il suo font-size esplicito.
 * CRITICO: non usare proprietà che fanno crescere il box in altezza (no wrap).
 */
function buildHeaderTemplate(docTitle) {
  return `<div style="box-sizing:border-box;width:100%;height:10mm;display:flex;align-items:center;justify-content:space-between;padding:0 16mm;border-bottom:0.5pt solid #DDDDDD;background:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:0;line-height:1.1;">
  <span style="font-size:9px;font-weight:bold;color:#2C2C2C;letter-spacing:0.5pt;line-height:1.1;white-space:nowrap;flex:0 0 auto;">PALLADIA</span>
  <span style="font-size:9px;color:#AAAAAA;line-height:1.1;flex:1;text-align:right;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding-left:8px;">${escT(docTitle)}</span>
</div>`;
}

/**
 * Footer Puppeteer — barra 9mm.
 * padding: 0 16mm → allineato al .doc { padding: 0 16mm }.
 * pageNumber / totalPages: Chrome li inietta prima di restituire il PDF
 * → sempre deterministici, zero stima, zero 2-pass manuale.
 * CRITICO: font-size esplicito su ogni <span>, altrimenti Chrome usa 0.
 */
function buildFooterTemplate(revision) {
  const rev = escT(String(revision || 1));
  return `<div style="box-sizing:border-box;width:100%;height:9mm;display:flex;align-items:center;justify-content:space-between;padding:0 16mm;border-top:0.5pt solid #DDDDDD;background:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:0;line-height:1.1;">
  <span style="font-size:8.5px;color:#BBBBBB;line-height:1.1;flex:1;white-space:nowrap;">D.Lgs 81/2008 e s.m.i.</span>
  <span style="font-size:8.5px;color:#444444;font-weight:bold;line-height:1.1;white-space:nowrap;flex:0 0 auto;">Pagina&#160;<span class="pageNumber" style="font-size:8.5px;"></span>&#160;/&#160;<span class="totalPages" style="font-size:8.5px;"></span></span>
  <span style="font-size:8.5px;color:#BBBBBB;line-height:1.1;flex:1;text-align:right;white-space:nowrap;">Rev.&#160;${rev}</span>
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

// ── Opzioni PDF ───────────────────────────────────────────────────────────────
// top:26mm   = header 10mm + 16mm respiro tra barra e primo rigo di testo
// bottom:24mm = footer  9mm + 15mm respiro tra ultimo rigo e barra
// left/right:0mm = laterali gestiti da .doc { padding: 0 16mm }
// Margini aumentati a 26/24mm per garantire separazione visiva netta
// tra header/footer e contenuto (dark-bg blocks non sembrano sovrapposti).
// Corrisponde a @page { margin: 26mm 0 24mm 0 } nel CSS.
function makePdfOpts(opts = {}) {
  return {
    format:              'A4',
    printBackground:     true,
    displayHeaderFooter: true,
    headerTemplate:      buildHeaderTemplate(opts.docTitle || ''),
    footerTemplate:      buildFooterTemplate(opts.revision || opts.rev || 1),
    margin: {
      top:    '26mm',
      bottom: '24mm',
      left:   '0mm',
      right:  '0mm',
    },
  };
}

// ── Debug overflow (solo se PDF_DEBUG=true) ───────────────────────────────────
// Logga i top-10 elementi che sforano orizzontalmente il .doc o verticalmente
// la safe area [top:22mm, bottom:277mm] — in pixel a 96dpi.
async function _debugOverflow(page) {
  const hits = await page.evaluate(() => {
    const doc  = document.querySelector('.doc');
    const maxW = doc ? doc.clientWidth : document.documentElement.clientWidth;
    // Safe area verticale: 26mm top ≈ 98px, 24mm bottom → limit 297mm-24mm=273mm ≈ 1032px
    const SAFE_TOP = 98;
    const SAFE_BTM = 1032;
    const results  = {};

    document.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const overflow_h = el.scrollWidth > maxW + 2;
      const overflow_v = r.top < -SAFE_TOP || r.bottom > SAFE_BTM;
      if (overflow_h || overflow_v) {
        const key = el.tagName.toLowerCase() +
          (el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/)[0] : '') +
          (overflow_h ? ' [W]' : '') + (overflow_v ? ' [V]' : '');
        results[key] = (results[key] || 0) + 1;
      }
    });
    return results;
  });

  const entries = Object.entries(hits).slice(0, 10);
  if (entries.length) {
    console.warn('[PDF_DEBUG] overflow rilevato (W=orizzontale, V=verticale):');
    entries.forEach(([s, n]) => console.warn(`  ${s}: ${n}`));
  } else {
    console.log('[PDF_DEBUG] OK — nessun overflow rilevato');
  }
}

// ── Semaforo — limita render PDF simultanei ───────────────────────────────────
class Semaphore {
  constructor(max) {
    this._max     = max;
    this._running = 0;
    this._queue   = [];
  }

  acquire() {
    if (this._running < this._max) {
      this._running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this._queue.push({ resolve, reject });
    });
  }

  release() {
    this._running--;
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      this._running++;
      next.resolve();
    }
  }
}

const pdfSemaphore = new Semaphore(MAX_CONCURRENT_PDF);

// ── renderHtmlToPdf (browser monouso) ─────────────────────────────────────────
async function renderHtmlToPdf(html, opts = {}) {
  if (!puppeteer) throw new Error('Puppeteer non installato. Esegui: npm install puppeteer');

  // Acquisisce il semaforo — se già MAX_CONCURRENT_PDF render in corso, aspetta
  const timer = setTimeout(() => {}, PDF_QUEUE_TIMEOUT_MS); // keep-alive per debug
  try {
    await Promise.race([
      pdfSemaphore.acquire(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('PDF_QUEUE_TIMEOUT')), PDF_QUEUE_TIMEOUT_MS)
      ),
    ]);
    clearTimeout(timer);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }

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
    pdfSemaphore.release();
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

  async render(html, opts = {}) {
    if (!puppeteer) throw new Error('Puppeteer non installato. Esegui: npm install puppeteer');

    // Semaforo condiviso — anche le render via pool contano nel limite
    await Promise.race([
      pdfSemaphore.acquire(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('PDF_QUEUE_TIMEOUT')), PDF_QUEUE_TIMEOUT_MS)
      ),
    ]);

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
      pdfSemaphore.release();
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

console.log(`[PDF] semaforo attivo — max ${MAX_CONCURRENT_PDF} render simultanei`);

module.exports = { renderHtmlToPdf, rendererPool, pdfSemaphore };
