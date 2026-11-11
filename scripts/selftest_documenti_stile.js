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

// F-493: quota di lettere scritte una per una nel PDF (Acrobat modifica bene solo testo a frasi intere)
const zlib = require('zlib');
function lettereSeparate(buf) {
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
  return sep / Math.max(1, sep + whole);
}
// I caratteri incorporati nel PDF (/BaseFont /AAAAAA+ArialMT …)
// Chrome scrive i caratteri scaricati come «Type3» (disegni senza nome): contano come non-Arial
const caratteriPdf = (buf) => {
  const t = buf.toString('latin1');
  const nomi = [...new Set((t.match(/\/BaseFont\s*\/[A-Z]{6}\+([A-Za-z0-9-]+)/g) || []).map(x => x.replace(/.*\+/, '')))];
  return /\/Subtype\s*\/Type3/.test(t) ? nomi.concat('Type3') : nomi;
};

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
  // F-493: Arial (su ogni PC; Chrome lo scrive a frasi intere), niente caratteri scaricati, niente spaziature tra lettere
  check('PSC: tutto in Arial, nessun carattere scaricato dal web (F-493)', /font-family:\s*Arial/.test(css) && !/Plus Jakarta|Archivo|fonts\.googleapis/.test(css), (css.match(/font-family:[^;]+/g) || []).slice(0, 4));
  const ls = (css.match(/letter-spacing:\s*-?[\d.]+(px|pt|em)/g) || []).filter(x => !/:\s*0(px|pt|em)?$/.test(x));
  check('PSC: nessuna spaziatura tra le lettere (spezza il testo in Acrobat)', ls.length === 0, ls.slice(0, 5));
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
  const sepPsc = lettereSeparate(Buffer.from(buf));
  check(`PSC: testo a frasi intere, lettere separate ≤ 15% (ora ${Math.round(sepPsc * 100)}%) (F-493)`, sepPsc <= 0.15, sepPsc);
  const fPsc = caratteriPdf(Buffer.from(buf));
  check('PSC: nel PDF solo Arial (c\'è su ogni PC, Acrobat e Affinity lo usano per modificare)', fPsc.length > 0 && fPsc.every(f => /^Arial(MT|-BoldMT|-ItalicMT|-BoldItalicMT)$/.test(f)), fPsc);

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
  check('POS: tutto in Arial, nessun carattere scaricato dal web (F-493)', /body\s*{[^}]*font-family:\s*Arial/.test(posCss) && !/Plus Jakarta|Archivo|fonts\.googleapis/.test(posCss), (posCss.match(/font-family:[^;]+/g) || []).slice(0, 4));
  const lsPos = (posHtml.match(/letter-spacing:\s*-?[\d.]+(px|pt|em)/g) || []).filter(x => !/:\s*0(px|pt|em)?$/.test(x));
  check('POS: nessuna spaziatura tra le lettere (spezza il testo in Acrobat)', lsPos.length === 0, lsPos.slice(0, 5));
  const posVecchi = ['#2C2C2C', '#1E1E1E', '#555555', '#AAAAAA'].concat(VECCHI).filter(c => posHtml.toUpperCase().includes(c));
  check('POS: nessun colore della grafica vecchia (barre nere, grigi caldi)', posVecchi.length === 0, posVecchi);
  check('POS: niente marchio «Palladia» in copertina', !/cover-sidebar-brand|>\s*Palladia\s*</.test(posHtml));
  const nLeg = (posHtml.match(/Legenda: P = probabilità/g) || []).length;
  check('POS: legenda dei rischi una volta sola (era sotto ogni lavorazione)', nLeg === 1, nLeg);
  const nOggetto = (posHtml.match(/>Oggetto dei lavori</g) || []).length;
  check('POS: oggetto dei lavori scritto una volta sola (era in sezione 1 e in 2.1)', nOggetto <= 1, nOggetto);
  const po = POS.posPdfOptions ? POS.posPdfOptions(posData, 1, 'Condominio Via Prova 9') : {};
  check('POS: in testa a ogni pagina l\'impresa, non «PALLADIA»', po.headerLeft === 'Edil Prova S.r.l.', po);
  const po2 = POS.posPdfOptions(posData, 1, 'Cantiere');
  check('POS: se la rotta non trova il nome usa il cantiere del POS, non «Cantiere»', /Condominio Via Prova 9/.test(po2.docTitle), po2.docTitle);
  const posPdf = await require('../pdf-renderer').rendererPool.render(posHtml, po.docTitle ? po : { docTitle: 'POS', revision: 1 });
  const posPagine = await paginePdf(posPdf);
  const TITOLI_POS = ['Fasi operative:', 'Rischi identificati e valutazione (matrice P x D):', 'Misure di prevenzione e protezione:', 'DPI obbligatori:', 'FASI OPERATIVE:', 'RISCHI IDENTIFICATI E VALUTAZIONE (MATRICE P X D):', 'MISURE DI PREVENZIONE E PROTEZIONE:', 'DPI OBBLIGATORI:'];
  const posOrfani = posPagine.filter(p => p.righe.length && (TITOLI_POS.includes(p.righe[p.righe.length - 1].t) || /^Lavorazione di prova \d$/.test(p.righe[p.righe.length - 1].t))).map(p => `pag. ${p.n}: «${p.righe[p.righe.length - 1].t}»`);
  check('POS: nessun titolo di blocco o di lavorazione da solo in fondo alla pagina', posOrfani.length === 0, posOrfani);
  const sepPos = lettereSeparate(Buffer.from(posPdf));
  check(`POS: testo a frasi intere, lettere separate ≤ 15% (ora ${Math.round(sepPos * 100)}%) (F-493)`, sepPos <= 0.15, sepPos);
  const fPos = caratteriPdf(Buffer.from(posPdf));
  check('POS: nel PDF solo Arial', fPos.length > 0 && fPos.every(f => /^Arial(MT|-BoldMT|-ItalicMT|-BoldItalicMT)$/.test(f)), fPos);

  // ── F-490 / F-491: Word vero ─────────────────────────────────────────────────
  console.log('\n\x1b[1mF-490 / F-491 — PSC e POS in Word (.docx vero)\x1b[0m');
  const AdmZip = require('adm-zip');
  const { htmlToDocx } = require('../lib/docxDocumento');
  const leggi = (buf) => {
    const z = new AdmZip(buf);
    const g = (n) => { const e = z.getEntry(n); return e ? e.getData().toString('utf8') : ''; };
    const tutti = (re) => z.getEntries().filter(e => re.test(e.entryName)).map(e => e.getData().toString('utf8')).join('');
    return { z, doc: g('word/document.xml'), header: tutti(/^word\/header\d*\.xml$/), footer: tutti(/^word\/footer\d*\.xml$/), fontTable: g('word/fontTable.xml') };
  };
  const testo = (xml) => (xml.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('');
  const pscDocx = await htmlToDocx(documento.pscHtml(snap, { perWord: true }), { headerLeft: 'Studio Ferrando', docTitle: 'PSC · prova', footerLeft: 'D.Lgs. 81/2008 · Allegato XV', revision: 0 });
  const W = leggi(pscDocx);
  check('PSC: è un .docx vero (zip con word/document.xml), non HTML rinominato', W.doc.includes('<w:body>') && pscDocx[0] === 0x50 && pscDocx[1] === 0x4B);
  const tw = testo(W.doc);
  check('PSC Word: copertina con titolo, revisione e opera', /Piano di Sicurezza/.test(tw) && /Rev\. 0/.test(tw) && /Scuola Media/.test(tw));
  check('PSC Word: niente testi incollati («Rev. 011 novembre», «1Identificazione»)', !/Rev\. 0\d{1,2} novembre/.test(tw) && !/\b1Identificazione/.test(tw), tw.slice(0, 300));
  check('PSC Word: in testa lo studio, in fondo «Pagina X di Y» con i campi di Word', /Studio Ferrando/.test(W.header) && /PAGE/.test(W.footer) && /NUMPAGES/.test(W.footer));
  const salti = (W.doc.match(/<w:pageBreakBefore\/>/g) || []).length;
  check('PSC Word: indice e sezioni principali su pagina nuova', salti >= 4, salti);
  // F-493: Arial, che c'è su ogni PC e in Word, LibreOffice e Google Docs (i caratteri incorporati lì vengono ignorati)
  const fontiWord = [...new Set((W.doc.match(/w:ascii="([^"]+)"/g) || []).map(x => x.slice(9, -1)))];
  check('PSC Word: tutto in Arial (si modifica uguale in Word, LibreOffice e Google Docs)', fontiWord.length > 0 && fontiWord.every(f => f === 'Arial') && !W.z.getEntries().some(e => /^word\/fonts\//.test(e.entryName)), fontiWord);
  check('PSC Word: cronoprogramma come tabella con le barre colorate', /w:fill="(10171F|B7832F|3E7C78)"/.test(W.doc));
  const posDocx = await htmlToDocx(posHtml, { ...po, title: po.docTitle });
  const PW = leggi(posDocx);
  const ptw = testo(PW.doc);
  check('POS Word: esiste, con copertina e le 14 sezioni', /Piano Operativo/.test(ptw) && /Presa visione dei lavoratori/.test(ptw));
  check('POS Word: in testa l\'impresa, niente segnaposto né UNKNOWN', /Edil Prova S\.r\.l\./.test(PW.header) && !/DA COMPILARE|UNKNOWN/.test(ptw));
  check('POS Word: «Pagina X di Y»', /NUMPAGES/.test(PW.footer));

  console.log(`\n${passed} passati, ${failed} falliti`);
  await require('../pdf-renderer').rendererPool.close().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
