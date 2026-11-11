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

  // ── F-489: POS ──────────────────────────────────────────────────────────────
  console.log('\n\x1b[1mF-489 — POS nella stessa famiglia del PSC, senza dati sporchi\x1b[0m');
  const POS = require('../pos-html-generator');
  const { selectSigns } = require('../sign-selector');
  // Dati inventati con gli stessi buchi del POS vero di Via Chiodo 9C:
  // codice fiscale del committente «UNKNOWN», email del CSE «<UNKNOWN>»,
  // telefono e importo mancanti.
  const posData = {
    companyName: 'Edil Prova S.r.l.', companyVat: '01234567890', companyAddress: 'Via Milano 1, 16100 Genova (GE)',
    datoreLavoro: 'Mario Rossi', rspp: 'Giulia Verdi', medico: 'Dott. Luca Neri', cse: 'Ing. Anna Bassi', cseEmail: '<UNKNOWN>',
    client: 'Condominio Via Prova 9', cfCommittente: 'UNKNOWN', siteAddress: 'Via Prova 9, Genova', siteName: 'Condominio Via Prova 9',
    descrizioneOpera: 'Manutenzione ordinaria del condominio', workType: 'Lavori in quota, demolizioni e rimozioni',
    tipoAppalto: 'subappalto', presentedBy: 'subappaltatore', affidatariaName: 'Impresa Affidataria S.r.l.',
    startDate: '2026-06-12', endDate: '2027-07-14',
    workers: [{ name: 'Luca Bianchi', qualification: 'Muratore' }, { name: 'Ahmed Kouri', qualification: 'Manovale' }],
  };
  const legenda = 'Legenda: P = probabilità (1 improbabile, 4 molto probabile); D = danno (1 lieve, 4 molto grave); R = P×D (1-3 basso, 4-7 medio, 8-11 alto, 12-16 molto alto).';
  const blocco = (nome) => [`### ${nome}`, '', '**Descrizione tecnica:** Lavorazione di prova.', '', '**Fasi operative:**', '- Prima fase', '- Seconda fase', '',
    '**Rischi identificati e valutazione (matrice P x D):**', '', '| Rischio | P (1-4) | D (1-4) | R (PxD) | Livello |', '|---|---|---|---|---|',
    '| Caduta dall\'alto | 3 | 4 | 12 | Molto alto |', '| Rumore | 3 | 2 | 6 | Medio |', '', legenda, '',
    '**Misure di prevenzione e protezione:**', '- Parapetti su tutti i lati', '- Otoprotettori', '', '**DPI obbligatori:**', '', '| DPI | Norma |', '|---|---|', '| Elmetto | UNI EN 397 |', ''].join('\n');
  const content = Array.from({ length: 9 }, (_, i) => blocco(`Lavorazione di prova ${i + 1}`)).join('\n\n---\n\n');
  const posHtml = await POS.generatePosHtml(posData, 1, content, selectSigns(posData));
  const sporchi = ['[DA COMPILARE]', 'UNKNOWN', '&lt;UNKNOWN&gt;'].filter(t => posHtml.includes(t));
  check('niente «[DA COMPILARE]» né «UNKNOWN» stampati', sporchi.length === 0, sporchi);
  const posCss = (posHtml.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
  check('POS: titoli in Archivo condensato e testo in Plus Jakarta Sans', /Archivo/.test(posCss) && /font-stretch:\s*7\d%/.test(posCss) && /body\s*{[^}]*Plus Jakarta Sans/.test(posCss));
  const posVecchi = ['#2C2C2C', '#1E1E1E', '#555555', '#AAAAAA'].concat(VECCHI).filter(c => posHtml.toUpperCase().includes(c));
  check('POS: nessun colore della grafica vecchia (barre nere, grigi caldi)', posVecchi.length === 0, posVecchi);
  check('POS: niente marchio «Palladia» in copertina', !/cover-sidebar-brand|>\s*Palladia\s*</.test(posHtml));
  const nLeg = (posHtml.match(/Legenda: P = probabilità/g) || []).length;
  check('POS: legenda dei rischi una volta sola (era sotto ogni lavorazione)', nLeg === 1, nLeg);
  const nOggetto = (posHtml.match(/>Oggetto dei lavori</g) || []).length;
  check('POS: oggetto dei lavori scritto una volta sola (era in sezione 1 e in 2.1)', nOggetto <= 1, nOggetto);
  const po = POS.posPdfOptions ? POS.posPdfOptions(posData, 1, 'Condominio Via Prova 9') : {};
  check('POS: in testa a ogni pagina l\'impresa, non «PALLADIA»', po.headerLeft === 'Edil Prova S.r.l.', po);
  const posPdf = await require('../pdf-renderer').rendererPool.render(posHtml, po.docTitle ? po : { docTitle: 'POS', revision: 1 });
  const posPagine = await paginePdf(posPdf);
  const TITOLI_POS = ['Fasi operative:', 'Rischi identificati e valutazione (matrice P x D):', 'Misure di prevenzione e protezione:', 'DPI obbligatori:', 'FASI OPERATIVE:', 'RISCHI IDENTIFICATI E VALUTAZIONE (MATRICE P X D):', 'MISURE DI PREVENZIONE E PROTEZIONE:', 'DPI OBBLIGATORI:'];
  const posOrfani = posPagine.filter(p => p.righe.length && (TITOLI_POS.includes(p.righe[p.righe.length - 1].t) || /^Lavorazione di prova \d$/.test(p.righe[p.righe.length - 1].t))).map(p => `pag. ${p.n}: «${p.righe[p.righe.length - 1].t}»`);
  check('POS: nessun titolo di blocco o di lavorazione da solo in fondo alla pagina', posOrfani.length === 0, posOrfani);

  console.log(`\n${passed} passati, ${failed} falliti`);
  await require('../pdf-renderer').rendererPool.close().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
