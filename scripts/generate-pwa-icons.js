#!/usr/bin/env node
'use strict';
/**
 * scripts/generate-pwa-icons.js
 * Genera le icone PNG per la PWA Palladia dal design del favicon.svg.
 *
 * Design: sfondo crema (#f0ece6) + angoli arrotondati + P bold nero (#1a1a1a)
 * Esegui: node scripts/generate-pwa-icons.js
 */

const sharp  = require('sharp');
const path   = require('path');
const fs     = require('fs');

const OUT_DIR = path.resolve(__dirname, '../../PALLADIA/palladia-main/palladia-main/public');

if (!fs.existsSync(OUT_DIR)) {
  console.error('❌ Cartella frontend non trovata:', OUT_DIR);
  process.exit(1);
}

/** Genera l'SVG dell'icona Palladia per una data dimensione in pixel */
function makeSvg(size) {
  // Proporzioni derivate dal favicon originale (viewBox 32x32)
  const rx         = Math.round(size * 7   / 32);   // border radius
  const fontSize   = Math.round(size * 22  / 32);   // bold P
  const textY      = Math.round(size * 24  / 32);   // baseline verticale centrata

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${rx}" fill="#f0ece6"/>
  <text
    x="${size / 2}"
    y="${textY}"
    font-family="Arial,Helvetica,sans-serif"
    font-size="${fontSize}"
    font-weight="800"
    fill="#1a1a1a"
    text-anchor="middle"
  >P</text>
</svg>`;
}

async function generate(size, filename) {
  const svg    = makeSvg(size);
  const outPath = path.join(OUT_DIR, filename);

  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outPath);

  const stats = fs.statSync(outPath);
  console.log(`✅  ${filename} (${size}×${size}) — ${Math.round(stats.size / 1024)} KB`);
}

async function main() {
  console.log('🎨  Generazione icone PWA Palladia...\n');

  await generate(512, 'icon-512.png');
  await generate(192, 'icon-192.png');
  await generate(180, 'apple-touch-icon.png');

  console.log('\n✅  Tutte le icone generate in:', OUT_DIR);
}

main().catch(err => {
  console.error('❌  Errore:', err.message);
  process.exit(1);
});
