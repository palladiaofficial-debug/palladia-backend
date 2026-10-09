#!/usr/bin/env node
/**
 * scripts/selftest_pos_pdf_text_runs.js — F-302 (AUDIT.md del frontend).
 *
 * Il PDF del POS non si modificava con Acrobat/Affinity: Chrome scriveva il
 * 66-76% delle lettere una per una (ognuna con le sue coordinate), perché le
 * dimensioni in pt cadevano su un terzo di pixel (10pt = 13,33px) e per la
 * crenatura. Verifica sul PDF vero, generato con la stessa pipeline della
 * rotta /api/generate-pdf:
 *  - al massimo il 15% delle lettere è scritto lettera per lettera (restano
 *    le etichette maiuscole spaziate della grafica);
 *  - nessuna dimensione del carattere in pt nell'HTML finale (tutte in px, a
 *    multipli di mezzo pixel);
 *  - il testo estratto dal PDF resta quello giusto, accenti ed euro compresi.
 */
'use strict';
const zlib = require('zlib');
const { generatePosHtml } = require('../pos-html-generator');
const { rendererPool } = require('../pdf-renderer');
const { selectSigns } = require('../sign-selector');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}

function glyphRuns(buf) {
  const t = buf.toString('latin1'); const re = /stream\r?\n/g; let m, sep = 0, whole = 0;
  while ((m = re.exec(t))) {
    const st = m.index + m[0].length, en = t.indexOf('endstream', st);
    let d; try { d = zlib.inflateSync(buf.subarray(st, en)).toString('latin1'); } catch { continue; }
    for (const blk of d.match(/BT[\s\S]*?ET/g) || []) {
      const tj = blk.match(/<[0-9A-Fa-f]+>\s*Tj/g) || [];
      const n = tj.reduce((a, x) => a + x.match(/<([0-9A-Fa-f]+)>/)[1].length / 4, 0);
      if (tj.length > 1) sep += n; else whole += n;
    }
  }
  return { sep, whole, share: sep / Math.max(1, sep + whole) };
}

async function main() {
  console.log('\n\x1b[1mF-302 — PDF del POS modificabile: testo a frasi intere, non lettera per lettera\x1b[0m');
  const posData = {
    companyName: 'Impresa Prova Srl', siteAddress: 'Via Lucarno 45, Genova', workType: 'Opere di manutenzione',
    datoreLavoro: 'Mario Rossi', rspp: 'Giulia Verdi', client: 'Condominio Via Lucarno',
    workers: [{ name: 'Luca Bianchi', qualification: 'Muratore', matricola: '' }, { name: 'Ahmed Kouri', qualification: 'Manovale', matricola: '' }],
  };
  const content = '### Manutenzione facciata\nLavori di manutenzione della facciata: caduta dall’alto, rumore, polveri. Importo € 1.000, attività già verificate.';
  const html = await generatePosHtml(posData, 1, content, selectSigns(posData));
  const pt = html.match(/font-size:\s*[\d.]+pt/g) || [];
  check('HTML: nessuna dimensione del carattere in pt', pt.length === 0, pt.slice(0, 5));
  const odd = (html.match(/font-size:\s*([\d.]+)px/g) || []).filter(x => (parseFloat(x.split(':')[1]) * 2) % 1 !== 0);
  check('HTML: dimensioni in px a multipli di mezzo pixel', odd.length === 0, odd.slice(0, 5));

  const pdf = Buffer.from(await rendererPool.render(html, { docTitle: 'POS – Prova – Rev. 1', revision: 1 }));
  const r = glyphRuns(pdf);
  check(`PDF: lettere scritte una per una ≤ 15% (ora ${Math.round(r.share * 100)}%)`, r.share <= 0.15, r);

  const { PDFParse } = require('pdf-parse');
  const text = (await new PDFParse({ data: pdf }).getText()).text.replace(/\s+/g, ' ');
  check('PDF: il testo estratto è quello giusto (accenti, euro, nomi)', /Opere di manutenzione/.test(text) && /caduta dall’alto/.test(text) && /€ 1\.000/.test(text) && /già verificate/.test(text) && /Ahmed Kouri/.test(text), text.slice(0, 300));

  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
