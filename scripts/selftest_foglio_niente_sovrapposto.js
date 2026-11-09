#!/usr/bin/env node
/**
 * scripts/selftest_foglio_niente_sovrapposto.js — F-476 (AUDIT.md del frontend).
 *
 * Il foglio ore del mese aperto in un browser vero (Puppeteer, misura A4
 * orizzontale, stampa), su un mese finto pieno come quelli di MSC: 31 giorni,
 * 12 lavoratori, ore a due decimali, straordinari, permessi a ore, quattro
 * cantieri. Misura invece di leggere il codice:
 *  - nessun testo esce dalla sua casella e i numeri dei giorni hanno tutti la
 *    stessa grandezza;
 *  - le righe dei lavoratori sono tutte alte uguali;
 *  - il totale non tocca la riga verticale;
 *  - la legenda sta su una riga sola;
 *  - la giornata di oggi, ancora aperta, non è rosa;
 *  - «Da verificare»: una riga per ogni cosa, non un muro di testo.
 * Excel «Ore del mese»: le caselle dei giorni non debordano (rimpiccioliscono).
 */
'use strict';
const { generateFoglioHtml, generateFoglioXlsx } = require('../lib/oreMeseFoglio');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 500)}`); failed++; }
}

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch { /* sotto */ }

// ── Mese finto: ottobre 2026, 12 lavoratori ────────────────────────────────
const SITI = { s1: 'Magazzino MSCedilizia', s2: 'Corso Sardegna 88', s3: 'Via Spalato 65', s4: 'Via San Nazaro 34' };
const days = Array.from({ length: 31 }, (_, i) => {
  const date = `2026-10-${String(i + 1).padStart(2, '0')}`;
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return { date, day: i + 1, dow, weekend: dow === 0 || dow === 6, festivo: null };
});
const vuoto = { ritardo: 0, uscitoPrima: 0, entratoPrima: 0, mezzaGiornata: false, oltreOrario: 0, motivo: null, permessoMin: 0, maltempoMin: 0, malattiaMin: 0, infortunioMin: 0, anomalia: false, pausaMin: 60, assenzaId: null, orario: null, primaEntrata: '08:00', ultimaUscita: '17:00' };
const ORE = [480, 418, 421, 478, 449, 302, 395, 4, 157, 464, 480, 375];
const NOMI = ['Binozi Armand', 'Canameti Ibrahim', 'Carlos Leon Castro', 'Carlos Sanchez Ganay', 'Daniel Miosi', 'Di Leonardo Carlo', 'Di Leonardo Giuseppe', 'Elvis Ricardo Castro', 'Festim Dervishaj', 'Lika Elton', 'Petriccione Raffaele', 'Raksasoi Suriya'];
const lavoratori = NOMI.map((nome, w) => {
  const cells = days.map((d, i) => {
    if (d.weekend) return { ...vuoto, date: d.date, tipo: 'weekend', ore: 0, straord: 0, perCantiere: {} };
    if (w === 5 && i % 3 === 0) return { ...vuoto, date: d.date, tipo: 'giustificare', ore: 0, straord: 0, perCantiere: {} };
    if (w === 2 && i === 5) return { ...vuoto, date: d.date, tipo: 'permesso', ore: 0, straord: 0, perCantiere: {}, permessoMin: 480 };
    const ore = ORE[(w + i) % ORE.length];
    const sito = w === 11 ? ['s2', 's3', 's1', 's4'][i % 4] : ['s1', 's2', 's3'][w % 3];
    return {
      ...vuoto, date: d.date, tipo: 'lavoro', ore, festivo: false, perCantiere: { [sito]: ore },
      straord: (w === 4 || w === 10) && i % 5 === 1 ? 150 : 0,
      permessoMin: w === 9 && i % 6 === 3 ? 110 : 0,
      maltempoMin: w === 7 && i % 7 === 2 ? 60 : 0,
    };
  });
  const tot = { ordinarieMin: cells.reduce((s, c) => s + (c.ore || 0), 0) * 10, straordMin: cells.reduce((s, c) => s + (c.straord || 0), 0), straordFestivoMin: 0, giorniLavorati: 22, perCantiere: {} };
  return { id: `w${w}`, nome, cf: `XXXYYY80A01D969${w}`, orario: null, cells, tot };
});
// Oggi, mese in corso: giornata aperta (entrata senza uscita) dopo l'ultima chiusa
lavoratori[0].cells[29] = { ...vuoto, date: days[29].date, tipo: null, ore: 0, straord: 0, perCantiere: {}, anomalia: true, primaEntrata: null, ultimaUscita: null };
lavoratori[1].cells[2] = { ...lavoratori[1].cells[2], ritardo: 17, primaEntrata: '08:17' };

const data = {
  month: '2026-10', from: '2026-10-01', to: '2026-10-31', days, giorniLavorativi: 22,
  azienda: { nome: 'MSCedilizia S.r.l.', piva: '02515980999' },
  cantieri: SITI,
  regole: { oreGiornoMin: 480, inizio: '08:00', fine: '17:00', pausaDa: '12:00', pausaA: '13:00', tolleranza: 5, straordSoglia: 30, straordBlocco: 30, confermato: true },
  assenze: [{ worker_id: 'w2', date_from: '2026-10-06', date_to: '2026-10-06', tipo: 'permesso' }],
  richieste: [], domande: [],
  lavoratori,
};

(async () => {
  console.log('\n\x1b[1mF-476 — foglio ore del mese: niente di sovrapposto\x1b[0m');
  const html = generateFoglioHtml(data, 'MSCedilizia S.r.l.');

  if (!puppeteer) { check('puppeteer disponibile per misurare il foglio', false); }
  else {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    try {
      const page = await browser.newPage();
      // A4 orizzontale a 96 dpi: 297 mm = 1123 px (i margini laterali del foglio sono nel CSS)
      await page.setViewport({ width: 1123, height: 794 });
      await page.emulateMediaType('print');
      await page.setContent(html, { waitUntil: 'load' });
      const m = await page.evaluate(() => {
        const r = (el) => el.getBoundingClientRect();
        const tds = [...document.querySelectorAll('table.mese tbody tr:not(.tot) td.d')];
        const fuori = [];
        const grandezze = new Set();
        for (const td of tds) {
          const box = r(td);
          for (const el of td.querySelectorAll('*')) {
            const b = r(el);
            if (b.width && (b.left < box.left - 0.5 || b.right > box.right + 0.5 || b.top < box.top - 0.5 || b.bottom > box.bottom + 0.5)) fuori.push(td.textContent);
          }
          // testo nudo nella casella: misurato con un Range
          // ogni pezzo di testo (non il blocco che lo contiene) con almeno 1,5 px
          // d'aria a sinistra e a destra: «5,027,02» erano dentro le caselle ma attaccati
          const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(n);
            const t = range.getBoundingClientRect();
            if (t.width && (t.left < box.left + 1.5 || t.right > box.right - 1.5)) fuori.push(td.textContent);
          }
          const main = td.querySelector('b') || (td.textContent.trim() ? td : null);
          if (main && /^\d/.test(main.textContent.trim())) grandezze.add(getComputedStyle(main).fontSize);
        }
        const righe = [...document.querySelectorAll('table.mese tbody tr:not(.tot)')].map(tr => Math.round(r(tr).height * 10) / 10);
        const tot = document.querySelector('table.mese tr.tot td.s.first');
        const totTxt = tot ? (() => { const rg = document.createRange(); rg.selectNodeContents(tot); return rg.getBoundingClientRect().left - r(tot).left; })() : -1;
        const legenda = [...new Set([...document.querySelectorAll('.key > span')].map(s => Math.round(r(s).top)))];
        const giornoAperto = document.querySelectorAll('table.mese tbody tr')[0].querySelectorAll('td.d')[29];
        const verifica = [...document.querySelectorAll('[data-sez="verifica"] li, [data-sez="verifica"] tr')].length;
        return { n: tds.length, fuori, grandezze: [...grandezze], righe, totTxt, legenda, apertoRosa: giornoAperto ? getComputedStyle(giornoAperto).backgroundColor : null, verifica };
      });
      check('312+ caselle dei giorni misurate', m.n >= 12 * 31, m.n);
      check('nessun testo esce dalla sua casella o ne tocca il bordo', m.fuori.length === 0, m.fuori.slice(0, 12));
      check('i numeri dei giorni hanno tutti la stessa grandezza', m.grandezze.length === 1, m.grandezze);
      check('le righe dei lavoratori sono alte uguali', new Set(m.righe).size === 1, m.righe);
      check('il totale non tocca la riga verticale (almeno 3 px)', m.totTxt >= 3, m.totTxt);
      check('la legenda sta su una riga sola', m.legenda.length === 1, m.legenda);
      check('la giornata di oggi, ancora aperta, non è rosa', m.apertoRosa && !/251, 227, 224/.test(m.apertoRosa), m.apertoRosa);
      check('«Da verificare»: una riga per ogni cosa (ritardi di Canameti, giorni di Di Leonardo Carlo…)', m.verifica >= 2, m.verifica);
    } finally { await browser.close(); }
  }

  // Excel: le caselle dei giorni non debordano nelle vicine
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await generateFoglioXlsx(data, 'MSCedilizia S.r.l.'));
  const ws = wb.getWorksheet('Ore del mese');
  let riga = null; ws.eachRow((row) => { if (row.getCell(1).value === 'Daniel Miosi') riga = row; });
  const giorni = riga ? Array.from({ length: 31 }, (_, i) => riga.getCell(i + 2)) : [];
  check('Excel: caselle dei giorni che rimpiccioliscono invece di debordare', giorni.length === 31 && giorni.every(c => c.alignment?.shrinkToFit === true), giorni[1]?.alignment);
  check('Excel: colonne dei giorni larghe almeno 6', Array.from({ length: 31 }, (_, i) => ws.getColumn(i + 2).width).every(w => w >= 6), ws.getColumn(2).width);

  console.log(`\n${passed} passati, ${failed} falliti`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
