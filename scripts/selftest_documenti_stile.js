#!/usr/bin/env node
/**
 * scripts/selftest_documenti_stile.js — F-492 (AUDIT.md del frontend).
 *
 * Il PDF del PSC deve avere lo stile della piattaforma (F-442) e
 * un'impaginazione pulita. Verifica sul PDF vero, generato con lo stesso
 * motore della rotta /psc/projects/:id/pdf, dal cantiere d'esempio salvato in
 * scripts/fixtures/psc_esempio_snapshot.json (dati finti, niente DB):
 *  - niente colori della generazione precedente (beige, blu #22384F, grigi caldi);
 *  - titoli in Archivo condensato, testo in Plus Jakarta Sans;
 *  - misure del testo in px e non in pt (F-302: con i pt Chrome scrive le
 *    lettere una per una e il PDF non si modifica);
 *  - nessun titolo di blocco («Rischi», «Fasi di lavoro», «Misure …») rimasto
 *    da solo in fondo a una pagina con il contenuto alla pagina dopo;
 *  - intestazione e piè di pagina con i colori nuovi; in testa lo studio.
 */
'use strict';
require('dotenv').config({ quiet: true });
const documento = require('../lib/psc/documento');
const store = require('../lib/psc/store');
const { buildHeaderTemplate, buildFooterTemplate } = require('../pdf-renderer');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}

const VECCHI = ['#F6F4F0', '#22384F', '#15120E', '#5F584F', '#D9D3C9', '#E4DED5', '#6A635A', '#FAF8F5', '#E7E2D8', '#FFFEFC', '#9C948A'];
const TITOLI_BLOCCO = ['Fasi di lavoro', 'Rischi', 'Misure di prevenzione e protezione', 'Macchine e attrezzature'];

async function paginePdf(buf) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const H = pg.getViewport({ scale: 1 }).height;
    const tc = await pg.getTextContent();
    // solo il corpo: fuori le bande di intestazione (26 mm) e piè di pagina (24 mm)
    const mm = 72 / 25.4;
    const righe = new Map();
    for (const it of tc.items) {
      const s = (it.str || '').trim(); if (!s) continue;
      const y = it.transform[5];
      if (y > H - 26 * mm + 2 || y < 24 * mm - 2) continue;
      const k = Math.round(y);
      righe.set(k, ((righe.get(k) || '') + ' ' + s).trim());
    }
    const ord = [...righe.entries()].sort((a, b) => b[0] - a[0]).map(([y, t]) => ({ y, t }));
    out.push({ n: i, righe: ord, H });
  }
  return out;
}

(async () => {
  const snap = require('./fixtures/psc_esempio_snapshot.json');

  console.log('\n\x1b[1mF-492 — stile del PSC\x1b[0m');
  const html = documento.pscHtml(snap);
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
  const trovati = VECCHI.filter(c => html.toUpperCase().includes(c));
  check('nessun colore della generazione precedente nel PSC', trovati.length === 0, trovati);
  check('titoli in Archivo condensato', /Archivo/.test(css) && /font-stretch:\s*7\d%/.test(css));
  check('testo in Plus Jakarta Sans', /Plus Jakarta Sans/.test(css));
  const pt = css.match(/font-size:\s*[\d.]+pt/g) || [];
  check('misure del testo in px, nessuna in pt (F-302)', pt.length === 0, pt.slice(0, 5));
  const hf = buildHeaderTemplate('PSC · prova', 'Studio Ferrando') + buildFooterTemplate(0, 'D.Lgs. 81/2008', null);
  const hfV = VECCHI.filter(c => hf.toUpperCase().includes(c));
  check('intestazione e piè di pagina con i colori nuovi', hfV.length === 0, hfV);

  console.log('\n\x1b[1mF-492 — impaginazione del PDF vero\x1b[0m');
  let opts = null;
  const buf = await store.renderPsc(snap, { render: async (h, o) => { opts = o; return require('../pdf-renderer').rendererPool.render(h, o); } });
  check('in testa a ogni pagina lo studio del coordinatore', opts && opts.headerLeft === 'Studio Ferrando', opts && opts.headerLeft);
  const pagine = await paginePdf(buf);
  const orfani = pagine.filter(p => p.righe.length && TITOLI_BLOCCO.includes(p.righe[p.righe.length - 1].t)).map(p => `pag. ${p.n}: «${p.righe[p.righe.length - 1].t}»`);
  check('nessun titolo di blocco da solo in fondo alla pagina', orfani.length === 0, orfani);
  const lavInTesta = pagine.filter(p => p.righe.length >= 2 && /^Settiman/.test(p.righe[p.righe.length - 1].t)).map(p => p.n);
  check('nessuna testata di lavorazione da sola in fondo alla pagina', lavInTesta.length === 0, lavInTesta);
  check('il PDF ha copertina, indice e le 12 sezioni', pagine.length >= 10 && pagine.some(p => p.righe.some(r => /Procedure complementari/.test(r.t))), pagine.length);

  console.log(`\n${passed} passati, ${failed} falliti`);
  await require('../pdf-renderer').rendererPool.close().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
