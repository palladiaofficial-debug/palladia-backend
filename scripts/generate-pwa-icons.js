#!/usr/bin/env node
'use strict';
/**
 * scripts/generate-pwa-icons.js
 * Genera le icone PWA Palladia con Sharp (SVG → PNG).
 *
 * Design: dark navy gradient + P geometrico bianco + accent bar blu
 * Output: public/icons/pwa-192.png, public/icons/pwa-512.png, public/apple-touch-icon.png
 * Esegui: node scripts/generate-pwa-icons.js
 */

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const FRONTEND_PUBLIC = path.resolve(__dirname, '../../PALLADIA/palladia-main/palladia-main/public');
const ICONS_DIR       = path.join(FRONTEND_PUBLIC, 'icons');

if (!fs.existsSync(FRONTEND_PUBLIC)) {
  console.error('Cartella frontend non trovata:', FRONTEND_PUBLIC);
  process.exit(1);
}
if (!fs.existsSync(ICONS_DIR)) fs.mkdirSync(ICONS_DIR, { recursive: true });

/**
 * Costruisce l'SVG dell'icona Palladia.
 * viewBox fisso 100x100, poi ridimensionato da Sharp alla risoluzione target.
 *
 * Struttura:
 *  - sfondo dark navy con gradiente diagonale
 *  - lettera P geometrica (stem + bowl D-shape) in bianco/argento
 *  - tre colonne verticali a destra in blu (motivo "pilastri cantiere")
 *  - barra accent orizzontale blu-indigo in basso
 *
 * NOTA: librsvg (usato da sharp) supporta linearGradient e path ma non filter/blur.
 */
function makeSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#0f172a"/>
      <stop offset="60%"  stop-color="#172554"/>
      <stop offset="100%" stop-color="#0c1525"/>
    </linearGradient>
    <linearGradient id="gP" x1="16" y1="9" x2="72" y2="91" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#cbd5e1"/>
    </linearGradient>
    <linearGradient id="gBar" x1="16" y1="0" x2="84" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#3b82f6"/>
      <stop offset="100%" stop-color="#6366f1"/>
    </linearGradient>
    <linearGradient id="gCol1" x1="0" y1="28" x2="0" y2="72" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#3b82f6" stop-opacity="0.65"/>
      <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.20"/>
    </linearGradient>
    <linearGradient id="gCol2" x1="0" y1="35" x2="0" y2="72" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#6366f1" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#6366f1" stop-opacity="0.10"/>
    </linearGradient>
    <linearGradient id="gCol3" x1="0" y1="42" x2="0" y2="72" gradientUnits="userSpaceOnUse">
      <stop offset="0%"   stop-color="#818cf8" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#818cf8" stop-opacity="0.05"/>
    </linearGradient>
  </defs>

  <!-- Sfondo -->
  <rect width="100" height="100" rx="18" fill="url(#bg)"/>

  <!-- Cerchio luminoso background (tocco di profondità) -->
  <circle cx="78" cy="22" r="38" fill="#1e40af" opacity="0.12"/>
  <circle cx="15" cy="85" r="25" fill="#4338ca" opacity="0.07"/>

  <!-- Lettera P — stem (barra verticale sinistra) -->
  <rect x="16" y="9" width="14" height="82" rx="3" fill="url(#gP)"/>

  <!-- Lettera P — bowl (forma a D: da y=9 a y=53, curva a destra) -->
  <!-- Path: top-left → top-right → arco semicircolare → bottom-right → bottom-left → chiude -->
  <path d="M 16,9 L 52,9 A 22,22 0 0 1 52,53 L 16,53 Z" fill="url(#gP)"/>

  <!-- Pilastri cantiere (destra) — tre colonne di altezza scalare -->
  <rect x="72" y="28" width="7" height="43" rx="3.5" fill="url(#gCol1)"/>
  <rect x="82" y="35" width="6" height="36" rx="3"   fill="url(#gCol2)"/>
  <rect x="63" y="42" width="5" height="29" rx="2.5" fill="url(#gCol3)"/>

  <!-- Barra accent in basso -->
  <rect x="16" y="94.5" width="68" height="4" rx="2" fill="url(#gBar)" opacity="0.90"/>
</svg>`;
}

async function generate(size, outPath) {
  await sharp(Buffer.from(makeSvg(size)))
    .resize(size, size)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outPath);

  const kb = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`  ${path.basename(outPath)}  (${size}x${size})  ${kb} KB  →  ${outPath}`);
}

async function main() {
  console.log('Generazione icone PWA Palladia...\n');

  await generate(512, path.join(ICONS_DIR,       'pwa-512.png'));
  await generate(192, path.join(ICONS_DIR,       'pwa-192.png'));
  await generate(180, path.join(FRONTEND_PUBLIC, 'apple-touch-icon.png'));

  console.log('\nFatto.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
