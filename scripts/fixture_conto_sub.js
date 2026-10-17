#!/usr/bin/env node
// F-360: genera il foglio d'esempio di un subappaltatore come arrivano davvero
// (griglia persone × giorni con formule, paga oraria, lavori a misura sotto,
// intestazioni sparse). Usato dall'e2e del frontend e per provare la lettura IA.
// Uso: node scripts/fixture_conto_sub.js <file.xlsx> [impresa] [YYYY-MM]
'use strict';
const ExcelJS = require('exceljs');

async function contoSubEsempio(file, impresa = 'AYAT SRLS', mese = '2026-09') {
  const [a, m] = mese.split('-').map(Number);
  const giorni = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const nomeMese = ['GENNAIO', 'FEBBRAIO', 'MARZO', 'APRILE', 'MAGGIO', 'GIUGNO', 'LUGLIO', 'AGOSTO', 'SETTEMBRE', 'OTTOBRE', 'NOVEMBRE', 'DICEMBRE'][m - 1];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`${nomeMese.slice(0, 3)} ${a}`);
  ws.addRow([`${impresa} - P.IVA 02987650993`]);
  ws.addRow([`RAPPORTINO ORE E LAVORI ${nomeMese} ${a}`]);
  ws.addRow(['Committente: MSC EDILIZIA SRL', '', '', '', '', 'Cantiere: VIA RIBOLI 4B GENOVA']);
  ws.addRow([]);
  ws.addRow(['OPERAIO', ...Array.from({ length: giorni }, (_, i) => i + 1), 'TOT ORE']).font = { bold: true };
  // Benali: i primi giorni lavorativi del mese (fino al 5) e il 14; Rossi: 2 e 21; Karim: 3
  const lav = (g) => { const d = new Date(Date.UTC(a, m - 1, g)).getUTCDay(); return d !== 0 && d !== 6; };
  const persone = [
    ['BENALI MOHAMED', (g) => ((g <= 5 && lav(g)) || g === 14 ? 8 : null)],
    ['ROSSI ALI', (g) => (g === 2 || g === 21 ? 8 : null)],
    ['KARIM AHMED', (g) => (g === 3 ? 8 : null)],
  ];
  let oreTot = 0;
  for (const [nome, f] of persone) {
    const valori = Array.from({ length: giorni }, (_, i) => f(i + 1));
    const somma = valori.reduce((s, v) => s + (v || 0), 0);
    oreTot += somma;
    const row = ws.addRow([nome, ...valori]);
    const ultima = ws.getColumn(giorni + 1).letter;
    // come un file salvato da Excel: formula con il risultato già calcolato
    row.getCell(giorni + 2).value = { formula: `SUM(B${row.number}:${ultima}${row.number})`, result: somma };
  }
  ws.addRow([]);
  ws.addRow(['PAGA ORARIA', '€ 28,00']);
  ws.addRow([]);
  ws.addRow(['LAVORI A MISURA', 'U.M.', 'QUANTITA', 'PREZZO', 'IMPORTO']).font = { bold: true };
  let mis = 0;
  for (const [voce, um, q, p] of [['Rasatura pareti', 'mq', 420, 8.5], ['Coloritura idropittura 2 mani', 'mq', 260, 6], ['Posa cartongesso', 'mq', 85, 22]]) {
    const r = ws.addRow([voce, um, q, p]);
    r.getCell(5).value = { formula: `C${r.number}*D${r.number}`, result: q * p };
    mis += q * p;
  }
  ws.addRow([]);
  ws.addRow(['TOTALE DA FATTURARE (iva in reverse charge)', '', '', '', { formula: 'SUM(E1:E60)', result: oreTot * 28 + mis }]);
  await wb.xlsx.writeFile(file);
  return { file, ore: oreTot, totale: oreTot * 28 + mis };
}

module.exports = { contoSubEsempio };
if (require.main === module && process.argv[2]) contoSubEsempio(process.argv[2], process.argv[3], process.argv[4]).then(r => console.log(r));
