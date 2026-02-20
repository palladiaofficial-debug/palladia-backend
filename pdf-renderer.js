'use strict';

/**
 * PDF Renderer — Puppeteer
 * Converte HTML in PDF A4.
 *
 * Header e footer sono gestiti tramite CSS position:fixed nel documento HTML
 * (vedi pos-html-generator.js → .pdf-header / .pdf-footer).
 * Questo evita il conflitto tra CSS @page margin e Puppeteer margin.
 *
 * Richiede: npm install puppeteer
 */

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (e) {
  // Puppeteer non installato — errore chiaro all'avvio
  puppeteer = null;
}

/**
 * Renderizza HTML → Buffer PDF usando Puppeteer.
 *
 * Header e footer sono CSS position:fixed nel documento HTML — non usare
 * displayHeaderFooter di Puppeteer (causa overlap non risolvibile).
 *
 * @param {string} html - HTML completo da convertire
 * @returns {Promise<Buffer>} - buffer PDF
 */
async function renderHtmlToPdf(html, opts = {}) {
  if (!puppeteer) {
    throw new Error(
      'Puppeteer non è installato. Esegui: npm install puppeteer\n' +
      'Nota: la prima installazione scarica Chromium (~170 MB).'
    );
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--font-render-hinting=none'
    ]
  });

  try {
    const page = await browser.newPage();

    // Imposta viewport A4 per compatibilità
    await page.setViewport({ width: 794, height: 1123 });

    // Carica il contenuto HTML
    await page.setContent(html, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    // Attendi che i font/layout siano pronti
    await page.evaluateHandle('document.fonts.ready');

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,

      // Header/footer sono CSS position:fixed nell'HTML — NON usare displayHeaderFooter.
      // I margini Puppeteer creano lo spazio fisico dove i fixed element atterrano.
      // I fixed element stanno a top:0/bottom:0 → nell'area del margine Puppeteer.
      // Il contenuto parte da Y=18mm (margine top) → NESSUNA SOVRAPPOSIZIONE.
      displayHeaderFooter: false,

      margin: {
        top:    '18mm',
        bottom: '18mm',
        left:   '15mm',
        right:  '15mm'
      }
    });

    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

/**
 * Versione con browser condiviso per performance in produzione.
 * Il browser rimane aperto tra le richieste successive.
 */
class PdfRendererPool {
  constructor() {
    this._browser = null;
    this._launching = null;
  }

  async _getBrowser() {
    if (this._browser) {
      try {
        // Verifica che il browser sia ancora vivo
        await this._browser.version();
        return this._browser;
      } catch {
        this._browser = null;
      }
    }
    if (this._launching) return this._launching;

    this._launching = puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote'
      ]
    }).then(b => {
      this._browser = b;
      this._launching = null;
      b.on('disconnected', () => {
        console.warn('[Puppeteer] browser disconnected — will relaunch on next request');
        this._browser = null;
      });
      return b;
    }).catch(err => {
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

      return await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: false,
        margin: { top: '18mm', bottom: '18mm', left: '15mm', right: '15mm' }
      });
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

// Istanza singleton del pool (usata dal server)
const rendererPool = new PdfRendererPool();

module.exports = { renderHtmlToPdf, rendererPool };
