'use strict';
/**
 * services/weatherReport.js
 *
 * F-160 (AUDIT.md): estrae la generazione HTML/Excel del "Registro Meteo
 * Cantiere" dalla route (routes/v1/siteWeather.js) in funzioni pure e
 * testabili — stesso pattern già in uso per Registro Presenze
 * (services/presenceReport.js) e Report Ore Lavorate
 * (services/workerHoursReport.js). Prima questa era l'unica generazione PDF/
 * Excel del prodotto ancora scritta inline nella route: non testabile senza
 * un server acceso, e per questo mai passata dal redesign F-154 che ha
 * portato lo stile reale Palladia agli altri due documenti.
 *
 * Palette/font: stessi token esatti di presenceReport.js/workerHoursReport.js
 * (mockup F-154 approvato) — Plus Jakarta Sans nel PDF, Calibri in Excel
 * (ExcelJS non incorpora font: un commercialista/ASL senza Plus Jakarta Sans
 * installato vedrebbe comunque il fallback di sistema).
 */

const ExcelJS = require('exceljs');

function toItShort(iso) {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

const DAYS_IT_LONG  = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
const DAYS_IT_SHORT = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

/**
 * @param {object} data
 * @param {object} data.site - { name, address, client, contract_days, days_type, start_date, end_date, weather_rain_mm, weather_wind_kmh, weather_snow, weather_thunderstorm }
 * @param {Array}  data.rows - righe site_weather_logs ordinate per log_date asc
 * @param {object} data.thresholds - { rain_mm, wind_kmh, snow, thunderstorm } — soglie effettive del cantiere
 * @param {string} [data.from]
 * @param {string} [data.to]
 * @returns {string} HTML pronto per rendererPool.render()
 */
function generateWeatherReportHtml({ site, rows, thresholds, from, to }) {
  const confirmedDays   = rows.filter(r => r.suspension_confirmed).length;
  const totalMm         = rows.reduce((s, r) => s + Number(r.precipitation_mm || 0), 0);
  const preliminaryDays = rows.filter(r => r.data_source !== 'era5_confirmed').length;
  const hasDiscrepancy  = rows.some(r => r.era5_discrepancy);

  const tableRows = rows.map(r => {
    const dt        = new Date(r.log_date + 'T00:00:00');
    const isConf    = r.suspension_confirmed;
    const isPending = r.threshold_exceeded && !r.suspension_confirmed && !r.suspension_dismissed;
    const rowClass  = isConf ? 'tr-conf' : isPending ? 'tr-pending' : '';
    const icon      = r.threshold_exceeded
      ? (r.threshold_reason === 'neve' ? '❄️' : r.threshold_reason === 'vento' ? '💨' : r.threshold_reason === 'temporale' ? '⛈️' : '🌧️')
      : (r.weather_code <= 3 ? '☀️' : '⛅');
    const isEra5 = r.data_source === 'era5_confirmed';

    let sospensioneHtml = '—';
    if (isConf) sospensioneHtml = '<span class="badge-anom">SOSPESO</span>';
    else if (r.suspension_dismissed) sospensioneHtml = 'Ignorato';
    else if (r.threshold_exceeded) sospensioneHtml = '<span class="badge-warn">Da confermare</span>';

    let fonteHtml = 'ERA5';
    if (r.era5_discrepancy) fonteHtml = '<span class="badge-anom">⚠ verifica</span>';
    else if (!isEra5) fonteHtml = '<span class="badge-warn">stima</span>';

    return `<tr class="${rowClass}">
      <td class="td-date">${r.log_date}</td>
      <td>${DAYS_IT_SHORT[dt.getDay()]}</td>
      <td>${icon} ${esc(r.weather_desc) || '—'}</td>
      <td class="td-center">${r.precipitation_mm > 0 ? r.precipitation_mm + ' mm' : '—'}</td>
      <td class="td-center">${r.wind_max_kmh > 0 ? r.wind_max_kmh + ' km/h' : '—'}</td>
      <td class="td-center">${r.temp_min_c != null ? r.temp_min_c + '°' : '—'} / ${r.temp_max_c != null ? r.temp_max_c + '°' : '—'}</td>
      <td class="td-center">${sospensioneHtml}</td>
      <td class="td-center">${fonteHtml}</td>
    </tr>`;
  }).join('');

  const period = esc((from || site.start_date || '—') + ' → ' + (to || site.end_date || 'oggi'));
  const nowStr = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

  return `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --primary: #22384F; --primary-tint: #EEF2F6;
  --text: #1A1714; --muted: #7A736A; --muted-2: #9C948A;
  --border: #E7E2D8; --border-strong: #D8D1C3;
  --warning: #A8672A; --warning-bg: #FBF3E8;
  --destructive: #A8453B; --destructive-bg: #FBF0EE;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; word-break: break-word; overflow-wrap: break-word; min-width: 0; }
html, body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Plus Jakarta Sans', Arial, Helvetica, sans-serif; font-size: 9.5pt; color: var(--text); line-height: 1.55; background: #FFFFFF; }
table { color: var(--text); }
.doc { width: 100%; max-width: 100%; box-sizing: border-box; padding: 0 16mm; }

.doc-eyebrow { display: inline-flex; align-items: center; gap: 6pt; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.9pt; text-transform: uppercase; color: var(--primary); background: var(--primary-tint); padding: 3pt 7pt 3pt 5pt; border-radius: 2.5pt; margin-bottom: 8pt; }
.doc-title { font-size: 19pt; font-weight: 700; letter-spacing: -0.3pt; color: var(--text); line-height: 1.2; margin-bottom: 3pt; }
.doc-title-rule { width: 22pt; height: 2.5pt; background: var(--primary); border-radius: 2pt; margin: 8pt 0 12pt; }

.meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8pt 10pt; margin-bottom: 14pt; padding-bottom: 12pt; border-bottom: 0.75pt solid var(--border); }
.meta-k { font-size: 6.5pt; font-weight: 700; letter-spacing: 0.6pt; text-transform: uppercase; color: var(--muted-2); margin-bottom: 1.5pt; }
.meta-v { font-size: 9.5pt; font-weight: 600; color: var(--text); line-height: 1.35; }

.section-title { display: flex; align-items: center; gap: 7pt; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.7pt; text-transform: uppercase; color: var(--muted); margin-top: 16pt; margin-bottom: 8pt; }
.section-title::after { content: ""; flex: 1; height: 0.75pt; background: var(--border); }

.summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6pt; margin-bottom: 14pt; }
.summary-card { border: 0.75pt solid var(--border); border-radius: 4pt; padding: 8pt 9pt; }
.sc-num { font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 15pt; font-weight: 600; color: var(--text); line-height: 1; margin-bottom: 4pt; }
.sc-label { font-size: 6.5pt; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5pt; font-weight: 600; }
.sc-warn { border-color: var(--warning); background: var(--warning-bg); }
.sc-warn .sc-num { color: var(--warning); }

.thresholds-box { display: flex; flex-wrap: wrap; gap: 5pt 14pt; background: var(--primary-tint); border-radius: 4pt; padding: 8pt 10pt; margin-bottom: 8pt; font-size: 8pt; color: var(--text); }
.thresholds-box strong { color: var(--primary); }
.source-note { font-size: 7.3pt; color: var(--muted); margin-bottom: 14pt; line-height: 1.55; }

.discrepancy-box { background: var(--destructive-bg); border: 0.75pt solid var(--destructive); border-radius: 4pt; padding: 9pt 10pt; margin-bottom: 14pt; }
.discrepancy-box p { font-size: 7.8pt; color: var(--text); line-height: 1.6; }
.discrepancy-box strong { color: var(--destructive); }

.weather-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 7.8pt; margin-bottom: 14pt; }
.weather-table thead th { padding: 0 4pt 6pt 0; font-size: 6.5pt; font-weight: 700; letter-spacing: 0.4pt; text-transform: uppercase; color: var(--muted); text-align: left; border-bottom: 1.5pt solid var(--text); }
.weather-table thead th.center { text-align: center; }
.weather-table tbody td { padding: 5.5pt 4pt 5.5pt 0; vertical-align: middle; line-height: 1.4; box-shadow: inset 0 -0.75pt 0 var(--border); }
.tr-conf td    { background: var(--destructive-bg) !important; }
.tr-pending td { background: var(--warning-bg) !important; }
.td-date   { font-weight: 600; color: var(--text); white-space: nowrap; }
.td-center { text-align: center; }
.badge-anom, .badge-warn {
  display: inline-block; font-size: 5.8pt; font-weight: 700;
  border-radius: 2.5pt; padding: 1.5pt 4pt; white-space: nowrap;
}
.badge-anom { background: var(--destructive-bg); color: var(--destructive); }
.badge-warn { background: var(--warning-bg); color: var(--warning); }

.declaration p { font-size: 7.3pt; color: var(--muted); line-height: 1.65; }

@media print {
  thead { display: table-header-group; }
  tr    { break-inside: avoid; page-break-inside: avoid; }
  h1, h2, h3, .section-title { break-after: avoid-page !important; page-break-after: avoid !important; }
  .summary-card, .discrepancy-box, .declaration { break-inside: avoid !important; page-break-inside: avoid !important; }
}
@page { size: A4; margin: 26mm 0 24mm 0; }
</style>
</head>
<body>
<div class="doc">

  <div class="doc-eyebrow">Registro meteo cantiere</div>
  <div class="doc-title">Registro Meteo Cantiere</div>
  <div class="doc-title-rule"></div>

  <div class="meta-grid">
    <div><div class="meta-k">Cantiere</div><div class="meta-v">${esc(site.name)}</div></div>
    <div><div class="meta-k">Committente</div><div class="meta-v">${esc(site.client) || '—'}</div></div>
    <div><div class="meta-k">Periodo</div><div class="meta-v">${period}</div></div>
    <div><div class="meta-k">Generato il</div><div class="meta-v">${esc(nowStr)}</div></div>
    ${site.address ? `<div style="grid-column:1/-1;"><div class="meta-k">Indirizzo cantiere</div><div class="meta-v">${esc(site.address)}</div></div>` : ''}
  </div>

  <div class="summary-grid">
    <div class="summary-card">
      <div class="sc-num">${rows.length}</div>
      <div class="sc-label">Giorni monitorati</div>
    </div>
    <div class="summary-card ${confirmedDays > 0 ? 'sc-warn' : ''}">
      <div class="sc-num">${confirmedDays}</div>
      <div class="sc-label">Sospensioni confermate</div>
    </div>
    <div class="summary-card">
      <div class="sc-num">${totalMm.toFixed(1)}</div>
      <div class="sc-label">Pioggia totale (mm)</div>
    </div>
    <div class="summary-card ${preliminaryDays > 0 ? 'sc-warn' : ''}">
      <div class="sc-num">${preliminaryDays}/${rows.length}</div>
      <div class="sc-label">In stima preliminare</div>
    </div>
  </div>

  ${site.contract_days ? `
  <div class="meta-grid">
    <div><div class="meta-k">Giorni contratto</div><div class="meta-v">${site.contract_days} (${esc(site.days_type) || 'solari'})</div></div>
    <div><div class="meta-k">Inizio lavori</div><div class="meta-v">${toItShort(site.start_date)}</div></div>
    <div><div class="meta-k">Fine lavori (aggiornata)</div><div class="meta-v">${toItShort(site.end_date)}</div></div>
  </div>` : ''}

  <div class="thresholds-box">
    <span>🌧️ Pioggia ≥ <strong>${thresholds.rain_mm} mm</strong>/giorno</span>
    <span>💨 Vento ≥ <strong>${thresholds.wind_kmh} km/h</strong></span>
    <span>❄️ Neve ${thresholds.snow ? '<strong>abilitata</strong>' : 'disabilitata'}</span>
    <span>⛈️ Temporale ${thresholds.thunderstorm ? '<strong>abilitato</strong>' : 'disabilitato'}</span>
  </div>
  <p class="source-note">Fonte: Open-Meteo / ERA5 (ECMWF). Ogni giorno viene registrato inizialmente come stima (Forecast API) e riconciliato automaticamente con il dato ERA5 confermato dopo circa 10 giorni — la colonna "Fonte" nella tabella indica lo stato per ciascun giorno. Dati verificabili su open-meteo.com e archive-api.open-meteo.com.</p>

  ${hasDiscrepancy ? `
  <div class="discrepancy-box">
    <p><strong>⚠ Discrepanze su giorni già decisi.</strong> Il dato ERA5 confermato per uno o più giorni già decisi (confermati o ignorati, marcati "⚠ verifica" nella colonna Fonte) differisce dalla stima originale al punto da cambiare il verdetto. Il verdetto NON è stato modificato automaticamente — verifica manualmente prima di comunicazioni ufficiali.</p>
  </div>` : ''}

  <div class="section-title">Dettaglio giornaliero</div>
  <table class="weather-table">
    <colgroup>
      <col style="width:11%"><col style="width:7%"><col style="width:21%">
      <col style="width:10%"><col style="width:10%"><col style="width:13%">
      <col style="width:16%"><col style="width:12%">
    </colgroup>
    <thead><tr>
      <th>Data</th><th>G.</th><th>Condizioni</th>
      <th class="center">Pioggia</th><th class="center">Vento max</th><th class="center">T° min/max</th>
      <th class="center">Sospensione</th><th class="center">Fonte</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>

  <div class="declaration">
    <p>Documento valido come prova documentale per richieste di proroga per cause di forza maggiore. Riferimenti normativi: D.Lgs. 36/2023 art. 107 (sospensione lavori) · D.M. 49/2018 art. 10 · art. 1664 c.c.</p>
  </div>

</div>
</body></html>`;
}

/**
 * @param {object} data - stessa forma di generateWeatherReportHtml
 * @returns {ExcelJS.Workbook}
 */
function generateWeatherReportXlsx({ site, rows, thresholds, from, to }) {
  const totalDays        = rows.length;
  const rainDays         = rows.filter(r => r.threshold_exceeded).length;
  const confirmedDays    = rows.filter(r => r.suspension_confirmed).length;
  const totalMm          = rows.reduce((s, r) => s + Number(r.precipitation_mm || 0), 0);
  const maxWind          = rows.reduce((m, r) => Math.max(m, Number(r.wind_max_kmh || 0)), 0);
  const preliminaryDays  = rows.filter(r => r.data_source !== 'era5_confirmed').length;

  const FONT           = 'Calibri';
  const PRIMARY        = '22384F';
  const TEXT           = '1A1714';
  const MUTED          = '7A736A';
  const WHITE          = 'FFFFFF';
  const WARNING        = 'A8672A';
  const WARNING_BG     = 'FBF3E8';
  const DESTRUCTIVE    = 'A8453B';
  const DESTRUCTIVE_BG = 'FBF0EE';
  const GRAY           = 'F7F5F1';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Palladia';
  wb.created = new Date();

  function headerCell(ws, row, col, value, width) {
    const cell = ws.getCell(row, col);
    cell.value = value;
    cell.font  = { bold: true, color: { argb: WHITE }, name: FONT, size: 10 };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRIMARY } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: PRIMARY } }, bottom: { style: 'thin', color: { argb: PRIMARY } },
      left: { style: 'thin', color: { argb: PRIMARY } }, right: { style: 'thin', color: { argb: PRIMARY } },
    };
    if (width) ws.getColumn(col).width = width;
  }
  function dataCell(cell, value, opts = {}) {
    cell.value = value;
    cell.font  = { name: FONT, size: 10, bold: opts.bold || false, italic: opts.italic || false, color: { argb: opts.color || TEXT } };
    if (opts.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
    cell.alignment = { vertical: 'middle', horizontal: opts.align || 'left', wrapText: false };
    if (opts.border !== false) cell.border = { bottom: { style: 'thin', color: { argb: 'E7E2D8' } } };
    if (opts.numFmt) cell.numFmt = opts.numFmt;
  }
  function metaRow(ws, label, value) {
    const r = ws.addRow([label, value]);
    r.getCell(1).font = { name: FONT, size: 10, bold: true, color: { argb: MUTED } };
    r.getCell(2).font = { name: FONT, size: 10, color: { argb: TEXT } };
    r.height = 16;
    return r;
  }

  const period = (from || site.start_date || '—') + ' → ' + (to || site.end_date || 'oggi');
  const genStr = `${new Date().toLocaleDateString('it-IT')} alle ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;

  // ── Foglio 1: Riepilogo ──────────────────────────────────────────────────
  const ws1 = wb.addWorksheet('Riepilogo');
  ws1.properties.defaultRowHeight = 18;
  ws1.getColumn(1).width = 42;
  ws1.getColumn(2).width = 40;

  ws1.mergeCells('A1:B1');
  const titleCell = ws1.getCell('A1');
  titleCell.value = 'PALLADIA — Registro Meteo Cantiere';
  titleCell.font  = { name: FONT, size: 16, bold: true, color: { argb: PRIMARY } };
  ws1.getRow(1).height = 28;
  ws1.addRow([]);

  metaRow(ws1, 'Cantiere', site.name || '—');
  if (site.address) metaRow(ws1, 'Indirizzo', site.address);
  if (site.client)  metaRow(ws1, 'Committente', site.client);
  metaRow(ws1, 'Periodo', period);
  metaRow(ws1, 'Generato il', genStr);
  ws1.addRow([]);

  metaRow(ws1, 'Giorni monitorati', totalDays);
  metaRow(ws1, 'Giorni con condizioni avverse', rainDays);
  metaRow(ws1, 'Giorni sospensione confermati', confirmedDays);
  metaRow(ws1, 'Precipitazioni totali periodo (mm)', totalMm.toFixed(1));
  metaRow(ws1, 'Vento massimo registrato (km/h)', maxWind.toFixed(1));
  const preliminaryRow = metaRow(ws1, 'Giorni ancora in stima preliminare (non riverificati ERA5)', `${preliminaryDays} / ${totalDays}`);
  if (preliminaryDays > 0) { preliminaryRow.getCell(1).font.color = { argb: WARNING }; preliminaryRow.getCell(2).font = { name: FONT, size: 10, bold: true, color: { argb: WARNING } }; }
  ws1.addRow([]);

  if (rows.some(r => r.era5_discrepancy)) {
    const wRow = ws1.addRow(['⚠ Discrepanze su giorni già decisi']);
    wRow.getCell(1).font = { name: FONT, size: 11, bold: true, color: { argb: DESTRUCTIVE } };
    ws1.mergeCells(`A${ws1.lastRow.number}:B${ws1.lastRow.number}`);
    const noteRow = ws1.addRow(['Il dato ERA5 confermato per uno o più giorni già decisi (confermati o ignorati, marcati "⚠" nel foglio Dettaglio) differisce dalla stima usata al momento della decisione, al punto da cambiare il verdetto. Il verdetto NON è stato modificato automaticamente: verifica manualmente prima di comunicazioni ufficiali.']);
    noteRow.getCell(1).font = { name: FONT, size: 9, color: { argb: DESTRUCTIVE } };
    noteRow.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    ws1.mergeCells(`A${ws1.lastRow.number}:B${ws1.lastRow.number}`);
    ws1.getRow(ws1.lastRow.number).height = 45;
    ws1.addRow([]);
  }

  if (site.contract_days) {
    metaRow(ws1, 'Giorni contratto', `${site.contract_days} (${site.days_type || 'solari'})`);
    metaRow(ws1, 'Data inizio lavori', toItShort(site.start_date));
    metaRow(ws1, 'Data fine contratto originale', toItShort(site.end_date));
    ws1.addRow([]);
  }

  metaRow(ws1, 'Soglia pioggia', `≥ ${thresholds.rain_mm} mm/giorno (dati giornalieri cumulati)`);
  metaRow(ws1, 'Soglia vento', `≥ ${thresholds.wind_kmh} km/h`);
  metaRow(ws1, 'Neve', thresholds.snow ? 'Codici WMO 71/73/75/77/85/86 — abilitata' : 'Disabilitata per questo cantiere');
  metaRow(ws1, 'Temporale/grandine', thresholds.thunderstorm ? 'Codici WMO ≥ 95 — abilitato' : 'Disabilitato per questo cantiere');
  ws1.addRow([]);

  metaRow(ws1, 'Fonte dati', 'Open-Meteo.com — ERA5 Climate Reanalysis (ECMWF)');
  const sourceNote = ws1.addRow(['', 'Ogni giorno viene registrato come stima (Forecast API) e riconciliato automaticamente col dato ERA5 confermato dopo ~10 giorni. La colonna "Fonte" nel foglio Dettaglio indica lo stato per ciascun giorno.']);
  sourceNote.getCell(2).font = { name: FONT, size: 9, italic: true, color: { argb: MUTED } };
  sourceNote.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  ws1.getRow(ws1.lastRow.number).height = 32;
  ws1.addRow([]);

  const legalRow = ws1.addRow(['', 'Documento valido come prova documentale per richieste di proroga per cause di forza maggiore — D.Lgs. 36/2023 art. 107 · D.M. 49/2018 art. 10 · art. 1664 c.c.']);
  legalRow.getCell(2).font = { name: FONT, size: 8.5, italic: true, color: { argb: MUTED } };
  legalRow.getCell(2).alignment = { wrapText: true };

  // ── Foglio 2: Dettaglio giornaliero ──────────────────────────────────────
  const ws2 = wb.addWorksheet('Dettaglio', { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws2.properties.defaultRowHeight = 18;

  const HEADER = ['Data', 'Giorno', 'Condizioni', 'Pioggia (mm)', 'Vento max (km/h)', 'T° min', 'T° max', 'Sospensione', 'Motivo', 'Fonte'];
  const hdrCols = [14, 12, 22, 14, 16, 10, 10, 18, 14, 24];
  hdrCols.forEach((w, i) => headerCell(ws2, 1, i + 1, HEADER[i], w));
  ws2.getRow(1).height = 24;
  ws2.views = [{ state: 'frozen', ySplit: 1 }];

  rows.forEach((r, i) => {
    const dt     = new Date(r.log_date + 'T00:00:00');
    const isConf = r.suspension_confirmed;
    const isPend = r.threshold_exceeded && !r.suspension_confirmed && !r.suspension_dismissed;
    const isEra5 = r.data_source === 'era5_confirmed';
    const rowBg  = isConf ? DESTRUCTIVE_BG : isPend ? WARNING_BG : (i % 2 === 1 ? GRAY : null);

    const row = ws2.addRow([]);
    row.height = 18;
    dataCell(row.getCell(1), r.log_date, { bg: rowBg, bold: true, align: 'center' });
    dataCell(row.getCell(2), DAYS_IT_LONG[dt.getDay()], { bg: rowBg, align: 'center' });
    dataCell(row.getCell(3), r.weather_desc || '—', { bg: rowBg });
    dataCell(row.getCell(4), Number(r.precipitation_mm) || 0, { bg: rowBg, align: 'center', numFmt: '0.0' });
    dataCell(row.getCell(5), Number(r.wind_max_kmh) || 0, { bg: rowBg, align: 'center', numFmt: '0.0' });
    dataCell(row.getCell(6), r.temp_min_c != null ? `${r.temp_min_c}°C` : '—', { bg: rowBg, align: 'center' });
    dataCell(row.getCell(7), r.temp_max_c != null ? `${r.temp_max_c}°C` : '—', { bg: rowBg, align: 'center' });
    dataCell(row.getCell(8), isConf ? 'SOSPESO' : (r.suspension_dismissed ? 'Ignorato' : (r.threshold_exceeded ? 'Da confermare' : '—')),
      { bg: rowBg, align: 'center', bold: isConf || isPend, color: isConf ? DESTRUCTIVE : (isPend ? WARNING : TEXT) });
    dataCell(row.getCell(9), r.threshold_reason || '—', { bg: rowBg, align: 'center' });
    dataCell(row.getCell(10), (isEra5 ? 'ERA5 confermato' : 'Stima preliminare') + (r.era5_discrepancy ? ' ⚠' : ''),
      { bg: rowBg, align: 'center', italic: !isEra5, bold: r.era5_discrepancy, color: r.era5_discrepancy ? DESTRUCTIVE : (isEra5 ? MUTED : WARNING) });
  });

  return wb;
}

module.exports = { generateWeatherReportHtml, generateWeatherReportXlsx };
