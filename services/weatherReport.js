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

// F-199 (AUDIT.md): "le icone mi sembrano troppo banali e IA" — sostituite
// le emoji (☀️🌧️⛈️❄️💨) con le stesse icone Phosphor (peso "bold") usate in
// tutta l'app (vedi src/lib/icons.ts, frontend) — "sempre Phosphor Icons,
// mai emoji" è una regola di stile già stabilita per il prodotto, questo
// export ne era rimasto l'unica eccezione. Path presi direttamente da
// @phosphor-icons/react (viewBox 0 0 256 256, peso bold), non ridisegnati
// a mano — stessa sorgente esatta dell'icona che l'utente vede nell'app.
const WEATHER_ICON_PATHS = {
  sun:       'M116,36V20a12,12,0,0,1,24,0V36a12,12,0,0,1-24,0Zm80,92a68,68,0,1,1-68-68A68.07,68.07,0,0,1,196,128Zm-24,0a44,44,0,1,0-44,44A44.05,44.05,0,0,0,172,128ZM51.51,68.49a12,12,0,1,0,17-17l-12-12a12,12,0,0,0-17,17Zm0,119-12,12a12,12,0,0,0,17,17l12-12a12,12,0,1,0-17-17ZM196,72a12,12,0,0,0,8.49-3.51l12-12a12,12,0,0,0-17-17l-12,12A12,12,0,0,0,196,72Zm8.49,115.51a12,12,0,0,0-17,17l12,12a12,12,0,0,0,17-17ZM48,128a12,12,0,0,0-12-12H20a12,12,0,0,0,0,24H36A12,12,0,0,0,48,128Zm80,80a12,12,0,0,0-12,12v16a12,12,0,0,0,24,0V220A12,12,0,0,0,128,208Zm108-92H220a12,12,0,0,0,0,24h16a12,12,0,0,0,0-24Z',
  cloud:     'M160,36A92.09,92.09,0,0,0,79,84.36,68,68,0,1,0,72,220h88a92,92,0,0,0,0-184Zm0,160H72a44,44,0,0,1-1.82-88A91.86,91.86,0,0,0,68,128a12,12,0,0,0,24,0,68,68,0,1,1,68,68Z',
  rain:      'M156,12A80.22,80.22,0,0,0,82.39,60.36,56.76,56.76,0,0,0,76,60a56,56,0,0,0,0,112h29.58L86,201.34a12,12,0,1,0,20,13.32L134.42,172H156a80,80,0,0,0,0-160Zm0,136H76a32,32,0,0,1,0-64h.28c-.11,1.1-.2,2.2-.26,3.3a12,12,0,1,0,24,1.39A56.06,56.06,0,1,1,156,148Zm.65,58.66-26.67,40a12,12,0,1,1-20-13.32l26.66-40a12,12,0,1,1,20,13.32Z',
  // F-200 (AUDIT.md): CloudLightning (nuvola + piccolo zigzag) condivideva
  // con "rain" lo stesso ingombro "nuvola + segno sottile sotto" — a 13pt
  // (la dimensione reale usata qui) il segno che le differenzia si perde,
  // verificato generando un PDF reale e confrontando i due path renderizzati
  // a piena dimensione (diversi) contro la stessa resa a 13pt (indistinguibili
  // a colpo d'occhio). Sostituito con "Lightning" (il fulmine pieno, senza
  // nuvola, stesso path esatto di Zap in src/lib/icons.tsx) — sagoma
  // completamente diversa da una nuvola, distinguibile anche in miniatura.
  lightning: 'M219.71,117.38a12,12,0,0,0-7.25-8.52L161.28,88.39l10.59-70.61a12,12,0,0,0-20.64-10l-112,120a12,12,0,0,0,4.31,19.33l51.18,20.47L84.13,238.22a12,12,0,0,0,20.64,10l112-120A12,12,0,0,0,219.71,117.38ZM113.6,203.55l6.27-41.77a12,12,0,0,0-7.41-12.92L68.74,131.37,142.4,52.45l-6.27,41.77a12,12,0,0,0,7.41,12.92l43.72,17.49Z',
  snowflake: 'M227.65,149.14a12,12,0,0,1-8.79,14.51l-20.67,5.08,5.4,20.16a12,12,0,0,1-23.18,6.22l-7.29-27.2L140,148.78V187l20.48,20.48a12,12,0,0,1-17,17L128,209l-15.51,15.52a12,12,0,0,1-17-17L116,187V148.78L82.88,167.91l-7.29,27.2a12,12,0,0,1-23.18-6.22l5.4-20.16-20.67-5.08a12,12,0,1,1,5.72-23.3l27.89,6.85L104,128,70.75,108.8l-27.89,6.85A11.8,11.8,0,0,1,40,116a12,12,0,0,1-2.85-23.65l20.67-5.08-5.4-20.16a12,12,0,0,1,23.18-6.22l7.29,27.2L116,107.21V69L95.52,48.48a12,12,0,0,1,17-17L128,47l15.51-15.52a12,12,0,1,1,17,17L140,69v38.24l33.12-19.12,7.29-27.2a12,12,0,0,1,23.18,6.22l-5.4,20.16,20.67,5.08A12,12,0,0,1,216,116a11.8,11.8,0,0,1-2.87-.35l-27.89-6.85L152,128l33.25,19.2,27.89-6.85A12,12,0,0,1,227.65,149.14Z',
  wind:      'M24,104a12,12,0,0,1,0-24h96a12,12,0,0,0,0-24,15.07,15.07,0,0,0-10.26,4.45,12,12,0,0,1-17-16.9A39.34,39.34,0,0,1,120,32a36,36,0,0,1,0,72ZM208,68a39.34,39.34,0,0,0-27.3,11.55,12,12,0,0,0,17,16.9A15.07,15.07,0,0,1,208,92a12,12,0,0,1,0,24H32a12,12,0,0,0,0,24H208a36,36,0,0,0,0-72Zm-56,84H40a12,12,0,0,0,0,24H152a12,12,0,0,1,0,24,15.11,15.11,0,0,1-10.27-4.45,12,12,0,1,0-17,16.9A39.34,39.34,0,0,0,152,224a36,36,0,0,0,0-72Z',
  cloudSun:  'M164,68a80.39,80.39,0,0,0-18.46,2.15,59.87,59.87,0,0,0-6-7.42l7.57-10.82a12,12,0,0,0-19.66-13.77L119.87,49A59.85,59.85,0,0,0,97.61,44l-2.3-13a12,12,0,0,0-23.63,4.17l2.3,13A60,60,0,0,0,54.77,60.47L43.91,52.86A12,12,0,0,0,30.14,72.52L41,80.11A59.45,59.45,0,0,0,36,102.36l-13,2.3a12,12,0,0,0,2.07,23.82,12.59,12.59,0,0,0,2.1-.18l13-2.3a59.29,59.29,0,0,0,3.44,7.25A56,56,0,0,0,84,228h80a80,80,0,0,0,0-160ZM96,68a36,36,0,0,1,26.45,11.61,80.37,80.37,0,0,0-32.06,36.75A56.5,56.5,0,0,0,84,116a55.84,55.84,0,0,0-20.33,3.83A36,36,0,0,1,96,68Zm68,136H84a32,32,0,0,1,0-64h.28c-.11,1.1-.2,2.2-.26,3.3a12,12,0,0,0,24,1.4,55.78,55.78,0,0,1,1.74-11l.15-.55A56.06,56.06,0,1,1,164,204Z',
};

// F-199 (AUDIT.md): "parzialmente nuvoloso" (WMO 2) mostrava lo stesso sole
// pieno di "sereno" (WMO 0) — innocuo con un'emoji minuscola, molto più
// evidente ora che è un'icona vettoriale grande quanto il testo. Allineato
// alla semantica WMO reale: 0-1 sereno/prevalentemente sereno, 2 parzialmente
// nuvoloso, 3+ coperto.
/** Icona condizione (colonna Condizioni): stesso criterio della emoji che sostituisce. */
function weatherIconKey(threshold_exceeded, threshold_reason, weather_code) {
  if (threshold_exceeded) {
    if (threshold_reason === 'neve')      return 'snowflake';
    if (threshold_reason === 'vento')     return 'wind';
    if (threshold_reason === 'temporale') return 'lightning';
    return 'rain';
  }
  if (weather_code <= 1) return 'sun';
  if (weather_code === 2) return 'cloudSun';
  return 'cloud';
}

/** SVG inline 13x13, colore neutro (--muted) — il colore di stato resta sulla colonna Sospensione, un'icona non deve duplicare il segnale. */
function weatherIconSvg(key) {
  const d = WEATHER_ICON_PATHS[key] || WEATHER_ICON_PATHS.cloud;
  return `<svg viewBox="0 0 256 256" width="13" height="13" style="vertical-align:-2.5px;margin-right:4pt;flex-shrink:0"><path d="${d}" fill="var(--muted)"/></svg>`;
}

const WARNING_CIRCLE_PATH = 'M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm-12-80V80a12,12,0,0,1,24,0v52a12,12,0,0,1-24,0Zm28,40a16,16,0,1,1-16-16A16,16,0,0,1,144,172Z';
/** Sostituisce ⚠ (emoji) nel PDF — stessa icona Phosphor "WarningCircle" bold usata nell'app per gli avvisi. */
function warningIconSvg(color = 'currentColor', size = 12) {
  return `<svg viewBox="0 0 256 256" width="${size}" height="${size}" style="vertical-align:-2px;margin-right:3pt"><path d="${WARNING_CIRCLE_PATH}" fill="${color}"/></svg>`;
}

/**
 * @param {object} data
 * @param {object} data.site - { name, address, client, contract_days, days_type, start_date, end_date, weather_rain_mm, weather_wind_kmh, weather_snow, weather_thunderstorm }
 * @param {Array}  data.rows - righe site_weather_logs ordinate per log_date asc
 * @param {object} data.thresholds - { rain_mm, wind_kmh, snow, thunderstorm } — soglie effettive del cantiere
 * @param {string} [data.from]
 * @param {string} [data.to]
 * @returns {string} HTML pronto per rendererPool.render()
 */
function generateWeatherReportHtml({ site, rows, thresholds, from, to, filter }) {
  const confirmedDays   = rows.filter(r => r.suspension_confirmed).length;
  const totalMm         = rows.reduce((s, r) => s + Number(r.precipitation_mm || 0), 0);
  // F-199 (AUDIT.md): "preliminare" è solo forecast_preliminary — un giorno
  // arpal_certified NON è una stima, prima veniva contato come tale (tutto
  // ciò che non era esattamente 'era5_confirmed').
  const preliminaryDays = rows.filter(r => r.data_source === 'forecast_preliminary').length;
  const hasDiscrepancy  = rows.some(r => r.era5_discrepancy);

  const tableRows = rows.map(r => {
    const dt        = new Date(r.log_date + 'T00:00:00');
    const isConf    = r.suspension_confirmed;
    const isPending = r.threshold_exceeded && !r.suspension_confirmed && !r.suspension_dismissed;
    const rowClass  = isConf ? 'tr-conf' : isPending ? 'tr-pending' : '';
    const icon      = weatherIconSvg(weatherIconKey(r.threshold_exceeded, r.threshold_reason, r.weather_code));
    let sospensioneHtml = '—';
    if (isConf) sospensioneHtml = '<span class="badge-anom">SOSPESO</span>';
    else if (r.suspension_dismissed) sospensioneHtml = 'Ignorato';
    else if (r.threshold_exceeded) sospensioneHtml = '<span class="badge-warn">Da confermare</span>';

    // F-199 (AUDIT.md): "ERA5" per qualunque riga non ancora certificata
    // ARPAL nascondeva che la maggior parte dei giorni sono oggi certificati
    // dalla stazione a terra — il titolare l'ha segnalato esplicitamente su
    // questa stessa distinzione nell'interfaccia ("dovrebbe esserci scritto
    // solo ARPAL, è così che guadagniamo la fiducia di tutti").
    let fonteHtml = r.data_source === 'arpal_certified' ? 'ARPAL' : r.data_source === 'era5_confirmed' ? 'ERA5' : '<span class="badge-warn">stima</span>';
    if (r.era5_discrepancy) fonteHtml = `<span class="badge-anom">${warningIconSvg('var(--destructive)')}verifica</span>`;

    // F-199 (AUDIT.md): con la fascia oraria attiva, precipitation_mm è già
    // filtrato sul turno — mostra anche il totale 24h intero per audit,
    // mai lasciarlo implicito in un documento pensato per un tribunale.
    const hasShiftNote = r.precipitation_mm_full_day != null && Number(r.precipitation_mm_full_day) !== Number(r.precipitation_mm);
    const pioggiaCell = (r.precipitation_mm > 0 ? r.precipitation_mm + ' mm' : '—') + (hasShiftNote ? ' *' : '');

    return `<tr class="${rowClass}">
      <td class="td-date">${r.log_date}</td>
      <td>${DAYS_IT_SHORT[dt.getDay()]}</td>
      <td style="display:flex;align-items:center;white-space:nowrap">${icon}${esc(r.weather_desc) || '—'}</td>
      <td class="td-center">${pioggiaCell}</td>
      <td class="td-center">${r.wind_max_kmh > 0 ? r.wind_max_kmh + ' km/h' : '—'}</td>
      <td class="td-center">${r.temp_min_c != null ? r.temp_min_c + '°' : '—'} / ${r.temp_max_c != null ? r.temp_max_c + '°' : '—'}</td>
      <td class="td-center">${sospensioneHtml}</td>
      <td class="td-center">${fonteHtml}</td>
    </tr>`;
  }).join('');

  const shiftRows = rows.filter(r => r.precipitation_mm_full_day != null && Number(r.precipitation_mm_full_day) !== Number(r.precipitation_mm));

  const FILTER_LABELS = { critical: 'solo giorni con soglia superata', confirmed: 'solo giorni con sospensione confermata' };
  const period = esc((from || site.start_date || '—') + ' → ' + (to || site.end_date || 'oggi'))
    + (FILTER_LABELS[filter] ? ` <span style="color:var(--warning);font-weight:700">(${FILTER_LABELS[filter]})</span>` : '');
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
    <span>${weatherIconSvg('rain')}Pioggia ≥ <strong>${thresholds.rain_mm} mm</strong>/giorno</span>
    <span>${weatherIconSvg('wind')}Vento ≥ <strong>${thresholds.wind_kmh} km/h</strong></span>
    <span>${weatherIconSvg('snowflake')}Neve ${thresholds.snow ? '<strong>abilitata</strong>' : 'disabilitata'}</span>
    <span>${weatherIconSvg('lightning')}Temporale ${thresholds.thunderstorm ? '<strong>abilitato</strong>' : 'disabilitato'}</span>
  </div>
  <p class="source-note">Fonte: precipitazione certificata dalla stazione ARPAL più vicina al cantiere — dato osservato da stazione a terra, lo standard riconosciuto da INPS per le richieste di Cassa Integrazione da maltempo (circolare n. 139 del 01/08/2016). Ogni giorno viene registrato inizialmente come stima (Open-Meteo) e certificato automaticamente da ARPAL entro circa 24 ore — la colonna "Fonte" nella tabella indica lo stato per ciascun giorno. Dati verificabili sul portale ufficiale ARPAL Liguria.${shiftRows.length ? ` * Cantiere con fascia oraria attiva: la pioggia mostrata conta solo le ore di turno, non le 24h intere — dato disponibile su richiesta per ${shiftRows.length} giorn${shiftRows.length === 1 ? 'o' : 'i'} in questo periodo.` : ''}</p>

  ${hasDiscrepancy ? `
  <div class="discrepancy-box">
    <p>${warningIconSvg('var(--destructive)', 13)}<strong>Discrepanze su giorni già decisi.</strong> Il dato certificato (ARPAL o ERA5) per uno o più giorni già decisi (confermati o ignorati, marcati "verifica" nella colonna Fonte) differisce dalla stima originale al punto da cambiare il verdetto. Il verdetto NON è stato modificato automaticamente — verifica manualmente prima di comunicazioni ufficiali.</p>
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
function generateWeatherReportXlsx({ site, rows, thresholds, from, to, filter }) {
  const totalDays        = rows.length;
  const rainDays         = rows.filter(r => r.threshold_exceeded).length;
  const confirmedDays    = rows.filter(r => r.suspension_confirmed).length;
  const totalMm          = rows.reduce((s, r) => s + Number(r.precipitation_mm || 0), 0);
  const maxWind          = rows.reduce((m, r) => Math.max(m, Number(r.wind_max_kmh || 0)), 0);
  // F-199 (AUDIT.md): come nell'HTML — solo forecast_preliminary è davvero
  // "in stima", arpal_certified/era5_confirmed sono entrambi confermati.
  const preliminaryDays  = rows.filter(r => r.data_source === 'forecast_preliminary').length;

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

  const XLSX_FILTER_LABELS = { critical: 'solo giorni con soglia superata', confirmed: 'solo giorni con sospensione confermata' };
  const period = (from || site.start_date || '—') + ' → ' + (to || site.end_date || 'oggi')
    + (XLSX_FILTER_LABELS[filter] ? ` (${XLSX_FILTER_LABELS[filter]})` : '');
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
  const preliminaryRow = metaRow(ws1, 'Giorni ancora in stima preliminare (non ancora certificati ARPAL)', `${preliminaryDays} / ${totalDays}`);
  if (preliminaryDays > 0) { preliminaryRow.getCell(1).font.color = { argb: WARNING }; preliminaryRow.getCell(2).font = { name: FONT, size: 10, bold: true, color: { argb: WARNING } }; }
  ws1.addRow([]);

  if (rows.some(r => r.era5_discrepancy)) {
    const wRow = ws1.addRow(['⚠ Discrepanze su giorni già decisi']);
    wRow.getCell(1).font = { name: FONT, size: 11, bold: true, color: { argb: DESTRUCTIVE } };
    ws1.mergeCells(`A${ws1.lastRow.number}:B${ws1.lastRow.number}`);
    const noteRow = ws1.addRow(['Il dato certificato (ARPAL o ERA5) per uno o più giorni già decisi (confermati o ignorati, marcati "⚠" nel foglio Dettaglio) differisce dalla stima usata al momento della decisione, al punto da cambiare il verdetto. Il verdetto NON è stato modificato automaticamente: verifica manualmente prima di comunicazioni ufficiali.']);
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

  metaRow(ws1, 'Fonte dati', 'ARPAL Liguria — stazione a terra (standard CIGO/INPS, circolare n. 139 del 01/08/2016)');
  const sourceNote = ws1.addRow(['', 'Ogni giorno viene registrato come stima (Open-Meteo) e certificato automaticamente da ARPAL entro circa 24 ore. La colonna "Fonte" nel foglio Dettaglio indica lo stato per ciascun giorno.']);
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
    const isPreliminary = r.data_source === 'forecast_preliminary';
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
    // F-199 (AUDIT.md): "ERA5 confermato"/"Stima preliminare" come uniche due
    // opzioni nascondeva che la maggior parte dei giorni sono oggi
    // certificati ARPAL (stazione a terra, non ERA5) — vedi lo stesso fix
    // nell'interfaccia (SiteWeatherSection.tsx).
    const fonteLabel = r.data_source === 'arpal_certified' ? 'ARPAL certificato' : r.data_source === 'era5_confirmed' ? 'ERA5 confermato' : 'Stima preliminare';
    dataCell(row.getCell(10), fonteLabel + (r.era5_discrepancy ? ' ⚠' : ''),
      { bg: rowBg, align: 'center', italic: isPreliminary, bold: r.era5_discrepancy, color: r.era5_discrepancy ? DESTRUCTIVE : (isPreliminary ? WARNING : MUTED) });
  });

  return wb;
}

module.exports = { generateWeatherReportHtml, generateWeatherReportXlsx };
