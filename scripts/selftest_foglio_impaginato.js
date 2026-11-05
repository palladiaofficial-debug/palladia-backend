#!/usr/bin/env node
/**
 * scripts/selftest_foglio_impaginato.js — F-433 (AUDIT.md del frontend).
 *
 * Il foglio mensile delle ore (PDF ed Excel) deve essere stampabile in modo
 * professionale. Senza DB, su un mese finto con due lavoratori:
 *  - margini del foglio = margini del renderer (prima 10 mm contro 26/24 mm:
 *    l'intestazione copriva il titolo e i titoli delle sezioni);
 *  - opzioni del PDF: orizzontale, intestazione col nome dell'impresa,
 *    piè di pagina del foglio presenze (non «D.Lgs 81/2008» del POS);
 *  - pagina 1 «Riepilogo del mese»: nella riga di ogni lavoratore, a destra,
 *    i cantieri dove ha lavorato con le ore di ciascuno;
 *  - Excel: colonna «Cantieri» nel Riepilogo, stampa orizzontale.
 */
'use strict';
const { generateFoglioHtml, generateFoglioXlsx, foglioPdfOpts } = require('../lib/oreMeseFoglio');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
}

const S1 = 'site-balbi', S2 = 'site-sardegna';
const days = [1, 2, 3, 4].map(d => ({ date: `2026-10-0${d}`, day: d, dow: [4, 5, 6, 0][d - 1], weekend: d >= 3, festivo: null }));
const vuoto = { ritardo: 0, uscitoPrima: 0, entratoPrima: 0, mezzaGiornata: false, oltreOrario: 0, motivo: null, permessoMin: 0, maltempoMin: 0, malattiaMin: 0, infortunioMin: 0, anomalia: false, pausaMin: 60, assenzaId: null, orario: null, primaEntrata: null, ultimaUscita: null };
const lavoro = (date, perCantiere, straord = 0) => ({ ...vuoto, date, tipo: 'lavoro', ore: 480, straord, festivo: false, perCantiere, primaEntrata: '08:00', ultimaUscita: '17:00' });
const libero = (date, tipo) => ({ ...vuoto, date, tipo, ore: 0, straord: 0, perCantiere: {} });
const tot = (o) => ({ ordinarieMin: 0, straordMin: 0, straordFestivoMin: 0, ferieGiorni: 0, permessoMin: 0, malattiaGiorni: 0, malattiaMin: 0, maltempoMin: 0, infortunioMin: 0, infortunioGiorni: 0, altroGiorni: 0, ingiustificataGiorni: 0, sospensioneGiorni: 0, daGiustificare: 0, anomalie: 0, giorniLavorati: 0, aggiunteMin: 0, ritardi: 0, ritardoMin: 0, uscitePrima: 0, uscitaPrimaMin: 0, mezzeGiornate: 0, entratePrima: 0, oreLavorabiliMin: 960, oreScoperteMin: 0, primaGiorni: 0, perCantiere: {}, ...o });

const data = {
  month: '2026-10', from: '2026-10-01', to: '2026-10-04', days, giorniLavorativi: 2,
  azienda: { nome: 'Edile Prova srl', piva: '01234567890' },
  cantieri: { [S1]: 'Via Balbi 31', [S2]: 'Corso Sardegna 88' },
  regole: { oreGiornoMin: 480, inizio: '08:00', fine: '17:00', pausaDa: '12:00', pausaA: '13:00', tolleranza: 5, straordSoglia: 30, straordBlocco: 30, confermato: true },
  assenze: [], richieste: [], domande: [],
  lavoratori: [
    { id: 'wA', nome: 'Anna Rossi', cf: 'RSSNNA80A41D969X', orario: null,
      cells: [lavoro('2026-10-01', { [S1]: 540 }, 60), { ...lavoro('2026-10-02', { [S2]: 480 }), corretto: { id: 'k1', entrata: '08:00', uscita: '17:00', siteId: S2, nota: 'badge scarico', prima: { entrata: '08:47', uscita: '17:00' } } }, libero('2026-10-03', 'weekend'), libero('2026-10-04', 'weekend')],
      tot: tot({ ordinarieMin: 960, straordMin: 60, giorniLavorati: 2, perCantiere: { [S1]: 540, [S2]: 480 } }) },
    { id: 'wB', nome: 'Bruno Bianchi', cf: 'BNCBRN75B12D969Y', orario: null,
      cells: [lavoro('2026-10-01', { [S1]: 480 }), libero('2026-10-02', 'giustificare'), libero('2026-10-03', 'weekend'), libero('2026-10-04', 'weekend')],
      tot: tot({ ordinarieMin: 480, giorniLavorati: 1, daGiustificare: 1, perCantiere: { [S1]: 480 } }) },
  ],
};

(async () => {
  console.log('\n\x1b[1mF-433 — foglio mensile delle ore impaginato\x1b[0m');
  const html = generateFoglioHtml(data, 'Edile Prova srl');

  // 1. Margini allineati al renderer (26/24 mm con intestazione e piè di pagina)
  check('@page: A4 orizzontale con i margini del renderer (26mm 0 24mm 0)', /@page\s*\{[^}]*size:\s*A4 landscape;[^}]*margin:\s*26mm 0 24mm 0/.test(html), (html.match(/@page\s*\{[^}]*\}/) || [])[0]);

  // 2. Opzioni del PDF
  check('foglioPdfOpts esiste', typeof foglioPdfOpts === 'function');
  if (typeof foglioPdfOpts === 'function') {
    const o = foglioPdfOpts(data, 'Edile Prova srl');
    check('PDF orizzontale', o.landscape === true, o);
    check('intestazione: nome dell\'impresa e mese', o.headerLeft === 'Edile Prova srl' && /ottobre 2026/i.test(o.docTitle), o);
    check('piè di pagina del foglio presenze, non del POS', /presenze/i.test(o.footerLeft || '') && !/81\/2008/.test(o.footerLeft || ''), o);
  }

  // 3. F-435: una tabella sola, i cantieri a destra nella riga del lavoratore
  const riep = (html.match(/<table class="mese"[\s\S]*?<\/table>/) || [''])[0];
  check('una tabella sola del mese', !!riep && (html.match(/<table/g) || []).length === 1, (html.match(/<table/g) || []).length);
  check('niente più pagina «Riepilogo del mese» separata', !html.includes('Riepilogo del mese'));
  const rigaA = (riep.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Anna Rossi[\s\S]*?<\/tr>/) || [''])[0];
  check('riga di Anna: Via Balbi 31 con 9 h e Corso Sardegna 88 con 8 h', /Via Balbi 31[\s\S]*?9/.test(rigaA) && /Corso Sardegna 88[\s\S]*?8/.test(rigaA), rigaA);
  check('i cantieri sono l\'ultima colonna della riga', /class="cant"[\s\S]*<\/td>\s*<\/tr>$/.test(rigaA.trim()), rigaA.slice(-200));
  const rigaB = (riep.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Bruno Bianchi[\s\S]*?<\/tr>/) || [''])[0];
  check('riga di Bruno: solo Via Balbi 31', rigaB.includes('Via Balbi 31') && !rigaB.includes('Corso Sardegna'), rigaB);
  check('i giorni sono nella stessa riga del lavoratore', (rigaA.match(/class="d/g) || []).length === 4, (rigaA.match(/class="d/g) || []).length);
  check('Anna, 2 ottobre: casella corretta (blu)', /class="d cor">8<\/td>/.test(rigaA), rigaA.slice(0, 600));
  check('correzioni dell\'ufficio con l\'orario di prima e il perché', html.includes("Correzioni dell'ufficio") && html.includes('entrata 08:47 → 08:00') && html.includes('badge scarico'));
  check('legenda nella stessa pagina', /class="key"[\s\S]*ferie[\s\S]*corretto dall'ufficio/.test(html));
  check('spazio per la firma', html.includes('Firma del datore di lavoro'));
  check('niente «D.Lgs 81/2008» nel foglio', !html.includes('81/2008'));
  const font = html.indexOf('font-family: "Inter PDF"; font-weight: 400; src: url(data:font/ttf;base64,');
  check('carattere Inter dentro il foglio (niente rete, uguale sul server)', font > 0 && /^[A-Za-z0-9+/]{1000}/.test(html.slice(html.indexOf('base64,', font) + 7)) && !html.includes('fonts.googleapis'));

  // 4. Excel
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await generateFoglioXlsx(data, 'Edile Prova srl'));
  check('Excel: primo foglio «Ore del mese»', wb.worksheets[0].name === 'Ore del mese', wb.worksheets.map(w => w.name));
  let rA0 = null; wb.worksheets[0].eachRow((row) => { if (row.getCell(1).value === 'Anna Rossi') rA0 = row; });
  check('Excel Ore del mese: giorni, ore e cantieri nella riga di Anna', rA0 && rA0.getCell(2).value === '8 +1' && /Via Balbi 31 9 h/.test(String(rA0.getCell(4 + 4).value)), rA0 && rA0.values);
  check('Excel: foglio «Correzioni»', !!wb.getWorksheet('Correzioni'));
  const ws = wb.getWorksheet('Riepilogo');
  let head = null, rA = null;
  ws.eachRow((row) => { if (row.getCell(1).value === 'Lavoratore') head = row; if (row.getCell(1).value === 'Anna Rossi') rA = row; });
  const col = head ? head.values.findIndex(v => v === 'Cantieri') : -1;
  check('Excel Riepilogo: colonna «Cantieri»', col > 0, head && head.values);
  check('Excel: per Anna «Via Balbi 31 · 9 h» e «Corso Sardegna 88 · 8 h»', col > 0 && rA && /Via Balbi 31 · 9 h/.test(String(rA.getCell(col).value)) && /Corso Sardegna 88 · 8 h/.test(String(rA.getCell(col).value)), rA && col > 0 ? rA.getCell(col).value : null);
  check('Excel: stampa orizzontale, una pagina in larghezza', ws.pageSetup.orientation === 'landscape' && ws.pageSetup.fitToWidth === 1, ws.pageSetup);

  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
