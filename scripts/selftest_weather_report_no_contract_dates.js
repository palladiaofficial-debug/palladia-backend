#!/usr/bin/env node
/**
 * scripts/selftest_weather_report_no_contract_dates.js
 *
 * Regressione per F-209 (AUDIT.md): il titolare, guardando un Registro
 * Meteo reale (Corso Ugo Bassi 28), ha segnalato "INIZIO LAVORI"/"FINE
 * LAVORI (AGGIORNATA)" come dati fuorvianti/sbagliati — il cantiere aveva
 * lavorato ben oltre la "fine lavori" mostrata (contratto prorogato senza
 * aggiornare end_date), e ha chiesto esplicitamente: "Non mettere più
 * inizio e fine lavori. Ma solo le date nella quale è stata richiesta la
 * verifica del meteo".
 *
 * Verifica:
 *   1. HTML e Excel NON contengono più "Inizio lavori"/"Fine lavori"/
 *      "Giorni contratto", anche quando site.contract_days è valorizzato.
 *   2. Il campo "Periodo" NON usa mai site.start_date/end_date (i dati
 *      contrattuali) — usa from/to se richiesti esplicitamente, altrimenti
 *      lo span reale delle righe nel report (le date davvero verificate).
 *
 * Test puro (nessuna chiamata DB/rete), stesso pattern di
 * selftest_weather_report_redesign_palette.js (F-160).
 */
'use strict';
require('dotenv').config();
const { generateWeatherReportHtml, generateWeatherReportXlsx } = require('../services/weatherReport');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 250)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

console.log('\nPalladia regression — niente inizio/fine lavori nel Registro Meteo (F-209)\n');

// Cantiere con contratto ampiamente scaduto rispetto ai dati meteo reali —
// esattamente lo scenario segnalato (Corso Ugo Bassi 28: contratto
// gen-apr 2026, dati meteo fino ad agosto).
const site = {
  name: 'TEST-F209 Cantiere', address: 'Via Test 209', client: 'TEST-F209 Committente',
  contract_days: 72, days_type: 'lavorativi', start_date: '2026-01-15', end_date: '2026-04-28',
  weather_rain_mm: 1, weather_wind_kmh: 50, weather_snow: true, weather_thunderstorm: true,
};
const thresholds = { rain_mm: 1, wind_kmh: 50, snow: true, thunderstorm: true };
// Righe ben OLTRE end_date (2026-04-28) — lo scenario reale segnalato.
const rows = [
  { log_date: '2026-07-10', precipitation_mm: 5,  wind_max_kmh: 10, temp_min_c: 20, temp_max_c: 28, weather_desc: 'pioggia leggera',  weather_code: 61, threshold_exceeded: true,  threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified', era5_discrepancy: false },
  { log_date: '2026-08-20', precipitation_mm: 64.2, wind_max_kmh: 17.8, temp_min_c: 21, temp_max_c: 25, weather_desc: 'pioggia leggera', weather_code: 61, threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified', era5_discrepancy: false },
];

const html = generateWeatherReportHtml({ site, rows, thresholds, from: undefined, to: undefined, filter: 'critical' });
check('HTML: nessuna traccia di "Inizio lavori"', !html.includes('Inizio lavori'), html.match(/Inizio lavori[^<]{0,40}/)?.[0]);
check('HTML: nessuna traccia di "Fine lavori"', !html.includes('Fine lavori'), html.match(/Fine lavori[^<]{0,40}/)?.[0]);
check('HTML: nessuna traccia di "Giorni contratto"', !html.includes('Giorni contratto'), html.match(/Giorni contratto[^<]{0,40}/)?.[0]);
check('HTML: il periodo mostrato NON è la durata contrattuale (15/01–28/04)', !html.includes('2026-01-15 → 2026-04-28'));
check('HTML: il periodo mostrato è lo span reale delle righe (10/07 → 20/08)', html.includes('2026-07-10 → 2026-08-20'));

const wb = generateWeatherReportXlsx({ site, rows, thresholds, from: undefined, to: undefined, filter: 'critical' });
const ws1 = wb.getWorksheet('Riepilogo');
const allCellsText = [];
ws1.eachRow(r => r.eachCell(c => allCellsText.push(String(c.value ?? ''))));
const flat = allCellsText.join(' | ');
check('Excel: nessuna traccia di "Giorni contratto"', !flat.includes('Giorni contratto'), flat.slice(0, 300));
check('Excel: nessuna traccia di "Data inizio lavori"', !flat.includes('Data inizio lavori'));
check('Excel: nessuna traccia di "Data fine contratto"', !flat.includes('Data fine contratto'));
check('Excel: il periodo mostrato è lo span reale delle righe, non la durata contrattuale',
  flat.includes('2026-07-10 → 2026-08-20') && !flat.includes('2026-01-15 → 2026-04-28'));

// Se from/to sono richiesti esplicitamente (intervallo libero dell'utente),
// quelli restano la fonte di verità — comportamento invariato.
const htmlWithRange = generateWeatherReportHtml({ site, rows, thresholds, from: '2026-02-01', to: '2026-09-01', filter: 'critical' });
check('HTML: un from/to esplicito viene comunque rispettato', htmlWithRange.includes('2026-02-01 → 2026-09-01'));

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}
report();
process.exit(process.exitCode || 0);
