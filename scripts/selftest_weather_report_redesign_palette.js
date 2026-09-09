#!/usr/bin/env node
/**
 * scripts/selftest_weather_report_redesign_palette.js
 *
 * Regressione per F-160 (AUDIT.md): il PDF/Excel "Registro Meteo Cantiere"
 * era rimasto l'unico export del prodotto ancora sul vecchio navy/Helvetica
 * generico — non aveva mai ricevuto il redesign "stile Palladia" (Plus
 * Jakarta Sans, #22384F) già fatto per Registro Presenze/Ore Lavorate
 * (F-154). Estratto da routes/v1/siteWeather.js in services/weatherReport.js
 * (stesso pattern di presenceReport.js/workerHoursReport.js) proprio per
 * renderlo testabile senza un server acceso — prima non lo era.
 *
 * Test puro (nessuna chiamata DB/rete): genera l'HTML del PDF e un XLSX
 * minimale con dati fittizi (inclusi un giorno da confermare, uno già
 * sospeso e uno con discrepanza ERA5), verifica che la palette/font nuovi
 * siano presenti, i vecchi valori generici spariti, e che i badge di stato
 * (SOSPESO/Da confermare/stima/discrepanza) compaiano correttamente.
 */
'use strict';
require('dotenv').config();
const { generateWeatherReportHtml, generateWeatherReportXlsx } = require('../services/weatherReport');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 250)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

console.log('\nPalladia regression — redesign PDF/Excel Registro Meteo Cantiere (F-160)\n');

const site = {
  name: 'TEST-Cantiere', address: 'Via Test 1', client: 'TEST Committente',
  contract_days: 90, days_type: 'solari', start_date: '2026-08-01', end_date: '2026-10-30',
  weather_rain_mm: 1, weather_wind_kmh: 50, weather_snow: true, weather_thunderstorm: true,
};
const thresholds = { rain_mm: 1, wind_kmh: 50, snow: true, thunderstorm: true };
const rows = [
  { log_date: '2026-08-01', precipitation_mm: 0, wind_max_kmh: 10, temp_min_c: 20, temp_max_c: 28, weather_desc: 'sereno', weather_code: 0, threshold_exceeded: false, threshold_reason: null, suspension_confirmed: false, suspension_dismissed: false, data_source: 'era5_confirmed', era5_discrepancy: false },
  { log_date: '2026-08-02', precipitation_mm: 15, wind_max_kmh: 12, temp_min_c: 18, temp_max_c: 24, weather_desc: 'pioggia intensa', weather_code: 65, threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false, data_source: 'era5_confirmed', era5_discrepancy: false },
  { log_date: '2026-08-03', precipitation_mm: 12, wind_max_kmh: 10, temp_min_c: 18, temp_max_c: 23, weather_desc: 'pioggia moderata', weather_code: 63, threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: true, suspension_dismissed: false, data_source: 'era5_confirmed', era5_discrepancy: false },
  { log_date: '2026-08-04', precipitation_mm: 0.5, wind_max_kmh: 8, temp_min_c: 20, temp_max_c: 27, weather_desc: 'pioggerella', weather_code: 51, threshold_exceeded: false, threshold_reason: null, suspension_confirmed: false, suspension_dismissed: false, data_source: 'forecast_preliminary', era5_discrepancy: false },
  { log_date: '2026-08-05', precipitation_mm: 3, wind_max_kmh: 30, temp_min_c: 15, temp_max_c: 22, weather_desc: 'pioggia leggera', weather_code: 61, threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: true, suspension_dismissed: false, data_source: 'era5_confirmed', era5_discrepancy: true },
];

// ── PDF (HTML pre-render) ────────────────────────────────────────────────
{
  const html = generateWeatherReportHtml({ site, rows, thresholds, from: '2026-08-01', to: '2026-08-05' });
  check('usa Plus Jakarta Sans (font reale Palladia)', html.includes('Plus Jakarta Sans'), null);
  check('usa il blu primario reale (#22384F)', html.includes('#22384F'), null);
  check('nessun residuo del vecchio navy generico (#1a1a2e)', !html.toLowerCase().includes('#1a1a2e'), null);
  check('nessun residuo del vecchio header custom (badge-palladia)', !html.includes('badge-palladia'), null);
  check('giorno da confermare mostra il badge "Da confermare"', /badge-warn">Da confermare/.test(html), null);
  check('giorno confermato mostra il badge "SOSPESO"', /badge-anom">SOSPESO/.test(html), null);
  check('giorno in stima preliminare mostra il badge "stima"', /badge-warn">stima/.test(html), null);
  check('giorno con discrepanza mostra il badge "⚠ verifica"', html.includes('⚠ verifica'), null);
  check('riquadro di avviso discrepanze presente quando serve', html.includes('Discrepanze su giorni già decisi'), null);
  check('conteggio "in stima preliminare" nel sommario (1/5)', html.includes('1/5'), null);
  check('citazione normativa reale presente (D.Lgs. 36/2023 art. 107)', html.includes('D.Lgs. 36/2023 art. 107'), null);
}

// giorno senza discrepanze: il riquadro di avviso non deve comparire
{
  const cleanRows = rows.filter(r => !r.era5_discrepancy);
  const html = generateWeatherReportHtml({ site, rows: cleanRows, thresholds, from: '2026-08-01', to: '2026-08-04' });
  check('nessun riquadro discrepanze quando non ce ne sono', !html.includes('Discrepanze su giorni già decisi'), null);
}

// ── Excel ─────────────────────────────────────────────────────────────────
{
  const wb = generateWeatherReportXlsx({ site, rows, thresholds, from: '2026-08-01', to: '2026-08-05' });
  check('workbook con i due fogli attesi (Riepilogo, Dettaglio)', wb.worksheets.map(w => w.name).join(',') === 'Riepilogo,Dettaglio', wb.worksheets.map(w => w.name));

  const ws1 = wb.getWorksheet('Riepilogo');
  const titleCell = ws1.getCell('A1');
  check('titolo Riepilogo usa il blu primario reale (#22384F)', titleCell.font.color.argb === '22384F', titleCell.font);
  check('titolo Riepilogo usa Calibri (font Excel reale, non Plus Jakarta Sans)', titleCell.font.name === 'Calibri', titleCell.font);

  const ws2 = wb.getWorksheet('Dettaglio');
  const headerCell = ws2.getCell(1, 1);
  check('header Dettaglio usa il blu primario reale come sfondo', headerCell.fill.fgColor.argb === '22384F', headerCell.fill);
  check('header Dettaglio testo bianco', headerCell.font.color.argb === 'FFFFFF', headerCell.font);

  // Riga 4 = 2026-08-03 (confermata) → colonna 8 "Sospensione" deve essere "SOSPESO" in rosso
  const confRow = ws2.getRow(4);
  check('riga confermata: valore SOSPESO in colonna Sospensione', confRow.getCell(8).value === 'SOSPESO', confRow.getCell(8).value);
  check('riga confermata: colore distruttivo reale (#A8453B)', confRow.getCell(8).font.color.argb === 'A8453B', confRow.getCell(8).font);

  // Riga 5 = 2026-08-04 (stima preliminare) → colonna 10 "Fonte" deve dirlo
  const prelimRow = ws2.getRow(5);
  check('riga in stima: colonna Fonte dice "Stima preliminare"', prelimRow.getCell(10).value === 'Stima preliminare', prelimRow.getCell(10).value);
}

console.log(`\n${passed} passati, ${failed} falliti\n`);
process.exitCode = failed > 0 ? 1 : 0;
