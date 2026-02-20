'use strict';

/**
 * PDF Renderer — Puppeteer
 * Converte HTML in PDF A4 con header/footer e page numbers.
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
 * Genera il template HTML dell'header (mostrato su tutte le pagine tranne la copertina).
 * Puppeteer NON eredita i font/stili del documento principale in questi template.
 */
function headerTemplate(docTitle) {
  return `
  <div style="
    font-family: Arial, Helvetica, sans-serif;
    font-size: 7.5pt;
    color: #555555;
    width: 100%;
    padding: 0 15mm;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    border-bottom: 0.5pt solid #CCCCCC;
    padding-bottom: 2pt;
    box-sizing: border-box;
    height: 100%;
  ">
    <span style="font-weight: bold; color: #3A3A3A; letter-spacing: 1pt;">PALLADIA</span>
    <span style="color: #666666;">${docTitle.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
  </div>`;
}

/**
 * Genera il template HTML del footer con "Pagina X di Y".
 */
function footerTemplate(revision) {
  return `
  <div style="
    font-family: Arial, Helvetica, sans-serif;
    font-size: 7.5pt;
    color: #555555;
    width: 100%;
    padding: 0 15mm;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-top: 0.5pt solid #CCCCCC;
    padding-top: 2pt;
    box-sizing: border-box;
    height: 100%;
  ">
    <span style="color: #888888;">D.lgs 81/2008 e s.m.i.</span>
    <span style="color: #3A3A3A; font-weight: bold;">
      Pagina <span class="pageNumber"></span> di <span class="totalPages"></span>
    </span>
    <span style="color: #888888;">Rev. ${revision}</span>
  </div>`;
}

/**
 * Renderizza HTML → Buffer PDF usando Puppeteer.
 *
 * @param {string} html - HTML completo da convertire
 * @param {object} opts - opzioni
 * @param {string} opts.docTitle - titolo per l'header
 * @param {number} opts.revision - revisione per il footer
 * @returns {Promise<Buffer>} - buffer PDF
 */
async function renderHtmlToPdf(html, opts = {}) {
  if (!puppeteer) {
    throw new Error(
      'Puppeteer non è installato. Esegui: npm install puppeteer\n' +
      'Nota: la prima installazione scarica Chromium (~170 MB).'
    );
  }

  const docTitle = opts.docTitle || 'Piano Operativo di Sicurezza';
  const revision = opts.revision || 1;

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

      // Header su tutte le pagine (inclusa copertina — ma la copertina usa @page:first margin:0
      // quindi l'header cade sopra la sidebar e non interferisce visivamente)
      displayHeaderFooter: true,
      headerTemplate: headerTemplate(docTitle),
      footerTemplate: footerTemplate(revision),

      // Margini: Puppeteer è l'UNICA autorità sui margini.
      // Il CSS @page nel documento HTML NON deve avere 'margin' —
      // avere margini in entrambi i posti causa overlap indefinito.
      // top/bottom a 22mm: dà spazio sufficiente a header e footer (font 7.5pt + bordo + padding).
      margin: {
        top:    '22mm',
        bottom: '22mm',
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

    const docTitle = opts.docTitle || 'Piano Operativo di Sicurezza';
    const revision = opts.revision || 1;
    const browser  = await this._getBrowser();
    const page     = await browser.newPage();

    try {
      await page.setViewport({ width: 794, height: 1123 });
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.evaluateHandle('document.fonts.ready');

      return await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: headerTemplate(docTitle),
        footerTemplate: footerTemplate(revision),
        margin: { top: '22mm', bottom: '22mm', left: '15mm', right: '15mm' }
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
