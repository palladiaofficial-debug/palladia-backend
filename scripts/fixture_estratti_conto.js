#!/usr/bin/env node
/**
 * scripts/fixture_estratti_conto.js — F-513: file di prova degli estratti conto,
 * nei formati (approssimati) di cinque banche italiane. Stessi movimenti in tutti:
 * i pagamenti delle fatture vere di Da pagare di MSC (importi e fornitori veri)
 * più movimenti che NON devono abbinare (stipendi, F24, incasso da un condominio).
 *   node scripts/fixture_estratti_conto.js   → scripts/fixtures/estratti/
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const DIR = path.join(__dirname, 'fixtures', 'estratti');
// data, importo (negativo = uscita), descrizione
const MOV = [
  ['2026-10-20', -2100.00, 'BONIFICO A FAVORE DI STELLI IMPIANTI DI STELLI MARCO FT 207/FE E 277/FE'],
  ['2026-10-22', -4702.00, 'BONIFICO SEPA A: GUARDALA GIUSEPPINA - SALDO FATTURA N.10'],
  ['2026-10-25', -922.47, 'ADDEBITO SDD WC LOC ITALIA SRL FATT 621169197'],
  ['2026-10-27', -3450.91, 'PAGAMENTO TRAMITE POS NEGOZIO 4412'],
  ['2026-10-27', -38471.53, 'STIPENDI OTTOBRE - DISPOSIZIONE CUMULATIVA'],
  ['2026-10-16', -5120.40, 'F24 TELEMATICO DELEGA UNIFICATA'],
  ['2026-10-30', 12000.00, 'BONIFICO DA CONDOMINIO VIA BALBI 31 - ACCONTO LAVORI'],
];
const it = (iso) => { const [a, m, g] = iso.split('-'); return `${g}/${m}/${a}`; };
const virgola = (n) => n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d),)/g, '.');

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  // 1. Intesa Sanpaolo (xlsx): righe di testata, poi le colonne; date vere e importi numerici
  {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Lista Movimenti');
    ws.addRow(['Lista movimenti']); ws.addRow(['Conto corrente', 'IT00 X000 0000 0000 0000 0000 000']); ws.addRow(['Periodo', 'dal 01/10/2026 al 31/10/2026']); ws.addRow([]);
    ws.addRow(['Data', 'Operazione', 'Dettagli', 'Conto o carta', 'Contabilizzazione', 'Categoria', 'Valuta', 'Importo']);
    for (const [d, imp, desc] of MOV) ws.addRow([new Date(`${d}T00:00:00Z`), desc.split(' ').slice(0, 2).join(' '), desc, 'Conto 1000/0001', 'CONTABILIZZATO', 'Altro', 'EUR', imp]);
    await wb.xlsx.writeFile(path.join(DIR, 'intesa.xlsx'));
  }
  // 2. UniCredit (csv ;, virgola decimale, importo con segno)
  fs.writeFileSync(path.join(DIR, 'unicredit.csv'), ['Data Registrazione;Data Valuta;Descrizione;Importo (EUR)', ...MOV.map(([d, imp, desc]) => `${it(d)};${it(d)};"${desc}";${virgola(imp)}`)].join('\r\n'));
  // 3. BPER (csv ;, Dare e Avere separati, positivi)
  fs.writeFileSync(path.join(DIR, 'bper.csv'), ['Data contabile;Data valuta;Dare;Avere;Descrizione operazione', ...MOV.map(([d, imp, desc]) => `${it(d)};${it(d)};${imp < 0 ? virgola(-imp) : ''};${imp > 0 ? virgola(imp) : ''};${desc}`)].join('\n'));
  // 4. Banco BPM (xlsx, ENTRATE/USCITE in testo all'italiana)
  {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Movimenti');
    ws.addRow(['DATA CONTABILE', 'DATA VALUTA', 'DESCRIZIONE', 'ENTRATE', 'USCITE']);
    for (const [d, imp, desc] of MOV) ws.addRow([it(d), it(d), desc, imp > 0 ? virgola(imp) : '', imp < 0 ? virgola(-imp) : '']);
    await wb.xlsx.writeFile(path.join(DIR, 'bancobpm.xlsx'));
  }
  // 5. Poste (csv ;, Addebiti/Accrediti (euro), anno a due cifre)
  fs.writeFileSync(path.join(DIR, 'poste.csv'), ['Data Contabile;Data Valuta;Addebiti (euro);Accrediti (euro);Descrizione operazioni', ...MOV.map(([d, imp, desc]) => { const [a, m, g] = d.split('-'); return `${g}/${m}/${a.slice(2)};${g}/${m}/${a.slice(2)};${imp < 0 ? virgola(-imp) : ''};${imp > 0 ? virgola(imp) : ''};${desc}`; })].join('\n'));
  console.log('Scritti in', DIR, fs.readdirSync(DIR).join(', '));
}
main().catch(e => { console.error(e); process.exit(1); });
