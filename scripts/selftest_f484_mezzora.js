#!/usr/bin/env node
/**
 * scripts/selftest_f484_mezzora.js — F-484 (AUDIT.md del frontend).
 *
 * Il titolare (10/11/2026): l'Excel delle ore va alla commercialista, che
 * accetta al massimo la mezz'ora: niente 145,79 o 123,67. Mese finto (niente
 * DB) con minuti «storti» (7 h 47, 7 h 25, 5 h 50 + 2 h 10 di permesso, due
 * cantieri nello stesso giorno). Controlla:
 *  - Excel: ogni numero di ore (giorni, totali, Riepilogo, Movimenti, Ore per
 *    cantiere) è un multiplo di 0,5;
 *  - PDF: nessun numero con decimali diversi da «,5»;
 *  - un giorno 5 h 50 + 2 h 10 di permesso resta 8 h in tutto (6 + 2);
 *  - i dati del mese (quelli della tabella in Palladia) non vengono toccati;
 *  - la legenda parla di mezz'ora, non di centesimi.
 */
'use strict';
const { generateFoglioHtml, generateFoglioXlsx } = require('../lib/oreMeseFoglio');

let passed = 0, failed = 0;
function check(name, cond, got) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 600)}`); failed++; }
}
const mezza = (x) => Math.abs(x * 2 - Math.round(x * 2)) < 1e-9;

const days = Array.from({ length: 30 }, (_, i) => {
  const date = `2026-11-${String(i + 1).padStart(2, '0')}`;
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return { date, day: i + 1, dow, weekend: dow === 0 || dow === 6, festivo: null };
});
const vuoto = { ritardo: 0, uscitoPrima: 0, entratoPrima: 0, mezzaGiornata: false, motivo: null, permessoMin: 0, maltempoMin: 0, malattiaMin: 0, infortunioMin: 0, anomalia: false, assenzaId: null, primaEntrata: '08:00', ultimaUscita: '17:00', aggiunteMin: 0 };
const STORTE = [467, 445, 470, 452, 478, 433, 480];
const lavoratori = ['Rossi Mario', 'Bianchi Luca'].map((nome, w) => {
  const cells = days.map((d, i) => {
    if (d.weekend) return { ...vuoto, date: d.date, tipo: 'weekend', ore: 0, straord: 0, perCantiere: {} };
    // lun 2: 5 h 50 + 2 h 10 di permesso
    if (i === 1) return { ...vuoto, date: d.date, tipo: 'lavoro', ore: 350, straord: 0, permessoMin: 130, perCantiere: { s1: 350 } };
    // mar 3: 5 h 45 + 2 h 15 di pioggia (pareggio: il totale resta 8)
    if (i === 2) return { ...vuoto, date: d.date, tipo: 'lavoro', ore: 345, straord: 0, maltempoMin: 135, perCantiere: { s1: 345 } };
    // mer 4: due cantieri (3 h 20 + 4 h 27) e 50 min di straordinario
    if (i === 3) return { ...vuoto, date: d.date, tipo: 'lavoro', ore: 467, straord: 50, perCantiere: { s1: 200, s2: 317 } };
    const ore = STORTE[(w + i) % STORTE.length];
    return { ...vuoto, date: d.date, tipo: 'lavoro', ore, straord: i % 4 === 1 ? 40 : 0, perCantiere: { [w ? 's2' : 's1']: ore + (i % 4 === 1 ? 40 : 0) } };
  });
  const s = (k) => cells.reduce((a, c) => a + (c[k] || 0), 0);
  const tot = { ordinarieMin: s('ore'), straordMin: s('straord'), straordFestivoMin: 0, permessoMin: s('permessoMin'), maltempoMin: s('maltempoMin'), malattiaMin: 0, infortunioMin: 0, giorniLavorati: cells.filter(c => c.tipo === 'lavoro').length, perCantiere: {}, ritardi: 0, ritardoMin: 0, uscitePrima: 0 };
  return { id: `w${w}`, nome, cf: `RSSMRA80A01H501${w}`, orario: null, cells, tot };
});
const data = {
  month: '2026-11', from: '2026-11-01', to: '2026-11-30', days, giorniLavorativi: 21,
  azienda: { nome: 'Prova F-484', piva: '' },
  cantieri: { s1: 'Via Roma 1', s2: 'Corso Italia 2' },
  regole: { oreGiornoMin: 480, inizio: '08:00', fine: '17:00', pausaDa: '12:00', pausaA: '13:00', tolleranza: 5, straordSoglia: 30, straordBlocco: 30, confermato: true },
  assenze: [], richieste: [], domande: [], lavoratori,
};
const prima = JSON.stringify(data);

(async () => {
  console.log('\n\x1b[1mF-484 — ore alla mezz\'ora nel foglio per la commercialista\x1b[0m');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await generateFoglioXlsx(data, 'Prova F-484')));
  const valore = (v) => (typeof v === 'number' ? v : v && typeof v.result === 'number' ? v.result : null);

  const s0 = wb.getWorksheet('Ore del mese');
  const storti = [];
  s0.eachRow((row, n) => { if (n < 6) return; row.eachCell((c, col) => { if (col < 3) return; const x = valore(c.value); if (x != null && !mezza(x)) storti.push(`R${n}C${col}=${x}`); }); });
  check('Excel «Ore del mese»: giorni e totali tutti a mezz\'ora', storti.length === 0, storti.slice(0, 8));

  const s1 = wb.getWorksheet('Riepilogo');
  const intest = []; s1.getRow(5).eachCell((c, i) => { intest[i] = String(c.value); });
  const colOre = intest.map((t, i) => (/\(ore\)|Ore |festive/.test(t || '') ? i : null)).filter(Boolean);
  const stortiR = [];
  s1.eachRow((row, n) => { if (n < 6) return; colOre.forEach((col) => { const x = valore(row.getCell(col).value); if (x != null && !mezza(x)) stortiR.push(`${intest[col]} R${n}=${x}`); }); });
  check('Excel «Riepilogo»: colonne di ore tutte a mezz\'ora', colOre.length >= 4 && stortiR.length === 0, { colOre, stortiR: stortiR.slice(0, 8) });

  const s3 = wb.getWorksheet('Movimenti');
  const stortiM = []; s3.eachRow((row, n) => { if (n > 1 && !mezza(Number(row.getCell(6).value))) stortiM.push(row.getCell(6).value); });
  check('Excel «Movimenti»: ore a mezz\'ora', stortiM.length === 0, stortiM.slice(0, 8));
  const s4 = wb.getWorksheet('Ore per cantiere');
  const stortiC = []; s4.eachRow((row, n) => { if (n > 5) [4, 5].forEach(k => { const x = row.getCell(k).value; if (typeof x === 'number' && !mezza(x)) stortiC.push(x); }); });
  check('Excel «Ore per cantiere»: ore a mezz\'ora', stortiC.length === 0, stortiC);

  // lun 2 (colonna D): Rossi ordinarie 6, permesso 2
  let r = null; s0.eachRow((row, n) => { if (row.getCell(1).value === 'Rossi Mario') r = r || n; });
  const rig = (k) => valore(s0.getRow(r + k).getCell(4).value);
  check('5 h 50 + 2 h 10 di permesso → 6 + 2 (il giorno resta 8 h)', rig(0) === 6 && rig(3) === 2, { ord: rig(0), per: rig(3) });
  const mar = (k) => valore(s0.getRow(r + k).getCell(5).value);
  check('5 h 45 + 2 h 15 di pioggia → in tutto ancora 8 h', mar(0) + mar(2) === 8 && mezza(mar(0)) && mezza(mar(2)), { ord: mar(0), pio: mar(2) });

  const html = generateFoglioHtml(data, 'Prova F-484');
  const corpo = html.replace(/<style>[\s\S]*?<\/style>/, '');
  const decimali = [...corpo.matchAll(/\b\d+,(\d+)\b/g)].map(m => m[0]).filter(x => !/,5$/.test(x));
  check('PDF: nessuna ora con i centesimi (solo intere o ,5)', decimali.length === 0, decimali.slice(0, 10));
  check('PDF: la legenda spiega la mezz\'ora, non i centesimi', /mezz.ora/i.test(corpo) && !/centesimi/i.test(corpo));

  // giorno di 4 minuti: 0 ore dopo l'arrotondamento → non è un giorno lavorato, né nel PDF né nell'Excel
  const d2 = JSON.parse(prima); const c9 = d2.lavoratori[1].cells[8]; Object.assign(c9, { ore: 4, straord: 0, perCantiere: { s2: 4 } });
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(Buffer.from(await generateFoglioXlsx(d2, 'Prova F-484')));
  let gl = null; wb2.getWorksheet('Riepilogo').eachRow((row) => { if (row.getCell(1).value === 'Bianchi Luca') gl = valore(row.getCell(3).value); });
  const attesi = d2.lavoratori[1].cells.filter(c => c.tipo === 'lavoro').length - 1;
  check('giorno di 4 minuti → 0 ore e non conta tra i giorni lavorati', gl === attesi, { gl, attesi });

  check('i dati del mese (tabella in Palladia) restano esatti, non modificati', JSON.stringify(data) === prima);

  console.log(`\n${passed} passati, ${failed} falliti.\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
