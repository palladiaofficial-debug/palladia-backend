#!/usr/bin/env node
/**
 * scripts/build_prezzario_liguria.js — F-293 (AUDIT.md del frontend).
 * Dal PDF ufficiale del Prezzario Regione Liguria al file dati della sezione 95
 * "Sicurezza" che Palladia include per tutti i coordinatori.
 *
 * Uso: node scripts/build_prezzario_liguria.js <prezzario.pdf> <anno>
 * (PDF pubblicato dalla Regione, es. ordinearchitetti.ge.it/.../Prezzario-2025.pdf)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { extractPdfText } = require('../lib/pdfExtract');
const { parseLiguriaPdfText } = require('../lib/psc/prezzario');

(async () => {
  const [file, anno] = process.argv.slice(2);
  if (!file || !/^\d{4}$/.test(anno || '')) { console.error('Uso: node scripts/build_prezzario_liguria.js <prezzario.pdf> <anno>'); process.exit(1); }
  const { text, numPages } = await extractPdfText(fs.readFileSync(file), { maxPages: 3000, minChars: 1 });
  const voci = parseLiguriaPdfText(text, { sezione: '95' });
  if (voci.length < 50) { console.error(`Solo ${voci.length} voci lette: il formato del PDF è cambiato?`); process.exit(1); }
  const out = {
    id: `liguria-${anno}`,
    nome: `Prezzario Regione Liguria ${anno} · Sicurezza`,
    regione: 'Liguria', anno: Number(anno), sezione: '95 - Sicurezza (D.Lgs. 81/2008)',
    fonte: 'Regione Liguria, Prezzario regionale delle opere edili ed impiantistiche',
    pagine_pdf: numPages, voci,
  };
  const dest = path.join(__dirname, '..', 'lib', 'psc', 'prezzari', `liguria-${anno}-sicurezza.json`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`${voci.length} voci → ${path.relative(process.cwd(), dest)}`);
})().catch(e => { console.error(e); process.exit(1); });
