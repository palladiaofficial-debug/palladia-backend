'use strict';
/**
 * services/pdfQuoteRenderer.js
 *
 * Genera un'immagine PNG con la citazione verbatim estratta da un documento.
 * Usa Puppeteer per fare uno screenshot di una card HTML branded Palladia.
 * Carica il PNG in Supabase Storage (temp/quote-cards/) e restituisce un URL firmato 2h.
 */

const crypto   = require('crypto');
const supabase = require('../lib/supabase');

const BUCKET       = 'site-documents';
const SIGNED_TTL   = 2 * 60 * 60; // 2 ore

let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

const LAUNCH_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--no-first-run', '--no-zygote',
];

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildCardHtml(citazione, nomeDoc, pagina) {
  const pageLabel = pagina ? `Pagina ${pagina}` : '';
  // Tronca il nome file se molto lungo
  const docShort = (nomeDoc || '').length > 60 ? (nomeDoc || '').slice(0, 57) + '…' : (nomeDoc || '');

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 640px;
    background: #ffffff;
    font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    padding: 24px 28px 22px 28px;
    border-left: 5px solid #1a1a1a;
    background: #ffffff;
  }
  .top-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .brand {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #9ca3af;
  }
  .page-label {
    font-size: 11px;
    font-weight: 600;
    color: #6b7280;
    background: #f3f4f6;
    padding: 2px 8px;
    border-radius: 4px;
  }
  .doc-name {
    font-size: 12px;
    font-weight: 700;
    color: #374151;
    margin-bottom: 14px;
    line-height: 1.4;
  }
  .quote-block {
    background: #f8f8f5;
    border-radius: 8px;
    padding: 16px 18px;
  }
  .quote-mark {
    font-size: 32px;
    color: #d1d5db;
    line-height: 0.8;
    margin-bottom: 8px;
    display: block;
  }
  .quote-text {
    font-size: 14.5px;
    line-height: 1.7;
    color: #1a1a1a;
    font-style: italic;
  }
</style>
</head>
<body>
<div class="card">
  <div class="top-row">
    <span class="brand" style="display:inline-flex;align-items:center;gap:4px"><svg width="8" height="9" viewBox="0 0 544 592" style="flex-shrink:0"><path fill="currentColor" fill-rule="evenodd" d="M 4 4 L 311 4 L 333 6 L 365 12 L 394 21 L 430 38 L 450 51 L 478 75 L 493 92 L 507 112 L 526 151 L 537 195 L 539 214 L 539 245 L 533 285 L 521 321 L 511 341 L 498 361 L 487 375 L 465 397 L 447 411 L 406 434 L 372 446 L 340 453 L 310 456 L 148 456 L 147 587 L 4 587 L 4 4 Z M 107 100 L 305 100 L 329 103 L 354 110 L 370 117 L 389 129 L 413 153 L 421 165 L 429 182 L 434 199 L 437 219 L 437 240 L 433 265 L 428 280 L 419 298 L 408 313 L 394 327 L 377 339 L 359 348 L 338 355 L 305 360 L 148 360 L 147 443 L 107 483 L 107 100 Z"/></svg>PALLADIA</span>
    ${pageLabel ? `<span class="page-label">${esc(pageLabel)}</span>` : ''}
  </div>
  <div class="doc-name">${esc(docShort)}</div>
  <div class="quote-block">
    <span class="quote-mark">"</span>
    <div class="quote-text">${esc(citazione)}</div>
  </div>
</div>
</body>
</html>`;
}

async function screenshotCard(html) {
  if (!puppeteer) throw new Error('Puppeteer non disponibile');

  const browser = await puppeteer.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 400, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    await page.evaluateHandle('document.fonts.ready');
    return await page.screenshot({ type: 'png', fullPage: true });
  } finally {
    await browser.close();
  }
}

/**
 * Genera la card PNG e la carica su Supabase Storage.
 * @param {{ citazione: string, nomeDoc: string, pagina: number|null }} opts
 * @returns {Promise<string>} URL firmato (2h)
 */
async function renderAndUploadQuoteCard({ citazione, nomeDoc, pagina }) {
  if (!citazione?.trim()) throw new Error('Citazione vuota');

  const html = buildCardHtml(citazione, nomeDoc, pagina);
  const pngBuffer = await screenshotCard(html);

  const storagePath = `temp/quote-cards/${crypto.randomUUID()}.png`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, pngBuffer, { contentType: 'image/png', upsert: false });

  if (error) throw new Error(`Upload quote card: ${error.message}`);

  const { data, error: signErr } = await supabase.storage
    .from(BUCKET).createSignedUrl(storagePath, SIGNED_TTL);

  if (signErr) throw new Error(`Signed URL quote card: ${signErr.message}`);
  return data.signedUrl;
}

module.exports = { renderAndUploadQuoteCard };
