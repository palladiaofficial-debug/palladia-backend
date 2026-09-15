#!/usr/bin/env node
/**
 * scripts/selftest_weather_report_filter_and_icons.js
 *
 * Regressione per F-199 (AUDIT.md): due segnalazioni del titolare sull'export
 * "Registro Meteo Cantiere".
 *
 * 1) "Se metto nei filtri 'soglie superate' per vedere solo i giorni che mi
 *    interessano, e poi vado ad esportare il PDF... ad oggi mi esporta
 *    comunque anche gli altri giorni". Il filtro categoria (critical/
 *    confirmed) applicato sullo schermo (SiteWeatherSection.tsx) non veniva
 *    mai passato all'export — solo l'intervallo di date lo era (F-159).
 *    routes/v1/siteWeather.js ora accetta ?filter=critical|confirmed su
 *    entrambe le route (.xlsx/.pdf).
 *
 * 2) "Le icone... mi sembrano troppo banali e IA" — le emoji (☀️🌧️⛈️❄️💨)
 *    nella colonna Condizioni del PDF sono sostituite dalle stesse icone
 *    Phosphor (peso bold) usate in tutta l'app, path presi direttamente da
 *    @phosphor-icons/react — non ridisegnate a mano.
 *
 * Blocco 1 (puro): generateWeatherReportHtml — nessuna emoji residua,
 * presenti i path SVG Phosphor attesi, l'etichetta periodo riflette il
 * filtro categoria passato.
 * Blocco 2 (live HTTP contro produzione): GET .../weather-report.xlsx con
 * ?filter=critical su un cantiere seminato con giorni misti — il file
 * scaricato (riparsato con ExcelJS) contiene SOLO i giorni con soglia
 * superata, non tutti quelli nel periodo.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');
const { generateWeatherReportHtml } = require('../services/weatherReport');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

const EMOJI_RE = /[☀-➿\u{1F300}-\u{1FAFF}]/u; // range emoji comuni (☀️🌧️⛈️❄️💨⛅🌫️ inclusi)

function block1Pure() {
  console.log('\nBlocco 1 — icone Phosphor al posto delle emoji nel PDF (puro, nessuna rete)\n');

  const site = { name: 'TEST-Cantiere', start_date: '2026-08-01', end_date: '2026-10-30' };
  const thresholds = { rain_mm: 1, wind_kmh: 50, snow: true, thunderstorm: true };
  const rows = [
    { log_date: '2026-08-01', precipitation_mm: 0, wind_max_kmh: 10, temp_min_c: 20, temp_max_c: 28, weather_desc: 'sereno', weather_code: 0, threshold_exceeded: false, threshold_reason: null, suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified' },
    { log_date: '2026-08-02', precipitation_mm: 15, wind_max_kmh: 12, temp_min_c: 18, temp_max_c: 24, weather_desc: 'pioggia intensa', weather_code: 65, threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified' },
    { log_date: '2026-08-03', precipitation_mm: 0, wind_max_kmh: 5, temp_min_c: 10, temp_max_c: 15, weather_desc: 'neve', weather_code: 71, threshold_exceeded: true, threshold_reason: 'neve', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified' },
    { log_date: '2026-08-04', precipitation_mm: 0, wind_max_kmh: 60, temp_min_c: 18, temp_max_c: 24, weather_desc: 'ventoso', weather_code: 3, threshold_exceeded: true, threshold_reason: 'vento', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified' },
    { log_date: '2026-08-05', precipitation_mm: 0, wind_max_kmh: 10, temp_min_c: 15, temp_max_c: 30, weather_desc: 'temporale', weather_code: 95, threshold_exceeded: true, threshold_reason: 'temporale', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified', era5_discrepancy: true },
    { log_date: '2026-08-06', precipitation_mm: 0, wind_max_kmh: 8, temp_min_c: 19, temp_max_c: 27, weather_desc: 'parzialmente nuvoloso', weather_code: 2, threshold_exceeded: false, threshold_reason: null, suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified' },
  ];

  const html = generateWeatherReportHtml({ site, rows, thresholds });
  check('nessuna emoji residua nel documento (sole/pioggia/temporale/neve/vento/avviso)', !EMOJI_RE.test(html), html.match(EMOJI_RE));
  check('icona SVG Sun (bold, Phosphor) presente per il giorno sereno', html.includes('M116,36V20a12,12,0,0,1,24,0V36'), null);
  check('icona SVG Snowflake presente per il giorno di neve', html.includes('M227.65,149.14a12,12,0,0,1-8.79,14.51'), null);
  check('icona SVG Wind presente per il giorno ventoso', html.includes('M24,104a12,12,0,0,1,0-24h96'), null);
  check('icona SVG WarningCircle presente per la discrepanza (non più ⚠ testuale)', html.includes('M128,20A108,108,0,1,0,236,128'), null);
  // F-199 (AUDIT.md): "parzialmente nuvoloso" (WMO 2) mostrava lo stesso sole
  // pieno di "sereno" (WMO 0) — un vero difetto, non solo estetico, in un
  // export a cui è stato chiesto lo "standard altissimo".
  check('icona SVG CloudSun (non il sole pieno) per "parzialmente nuvoloso" (WMO 2)', html.includes('M164,68a80.39,80.39,0,0,0-18.46,2.15'), null);

  const htmlFiltered = generateWeatherReportHtml({ site, rows: rows.filter(r => r.threshold_exceeded), thresholds, filter: 'critical' });
  check('etichetta periodo riflette il filtro "solo soglie superate" quando passato', htmlFiltered.includes('solo giorni con soglia superata'), null);

  // F-200 (AUDIT.md): trovato generando davvero il PDF e guardandolo — a 13pt
  // (la dimensione reale in tabella) l'icona "temporale" (nuvola+zigzag) era
  // indistinguibile a colpo d'occhio da "pioggia" (nuvola+due tratti), pur
  // essendo due path SVG diversi: entrambe condividevano lo stesso ingombro
  // "nuvola + segno sottile sotto" che a quella dimensione si perde. Sostituita
  // con "Lightning" (il fulmine pieno, senza nuvola — stesso path di Zap in
  // src/lib/icons.tsx, frontend), sagoma del tutto diversa da una nuvola.
  // Riga isolata (nessuna riga "pioggia" nello stesso HTML) per non far
  // passare il test per un falso positivo sul prefisso nuvola condiviso.
  const htmlLightningOnly = generateWeatherReportHtml({
    site, thresholds,
    rows: [{ log_date: '2026-08-05', precipitation_mm: 0, wind_max_kmh: 10, temp_min_c: 15, temp_max_c: 30, weather_desc: 'temporale', weather_code: 95, threshold_exceeded: true, threshold_reason: 'temporale', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified' }],
  });
  check('icona "temporale" è il fulmine pieno (Lightning), non più nuvola+zigzag', htmlLightningOnly.includes('M219.71,117.38a12,12,0,0,0-7.25-8.52'), null);
  // Nota: il riquadro soglie (thresholds-box) mostra SEMPRE la pillola
  // "Pioggia" con l'icona rain (nuvola) — il vecchio prefisso condiviso
  // "M156,12A80.22..." compare quindi comunque nel documento tramite quella
  // pillola, a prescindere dalla riga temporale; non è un buon segnale su
  // cui testare "nessuna condivisione col prefisso nuvola" a livello di
  // intero HTML — la pin positiva sopra basta a proteggere la regressione.
}

async function block2LiveExportFilter() {
  console.log('\nBlocco 2 — export .xlsx rispetta il filtro "soglie superate" (live HTTP contro produzione)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) { skip('export filtrato live', 'fixture Supabase non configurate'); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find(u => u.email === 'ci-test@palladia.internal');
  if (!user) { skip('export filtrato live', 'utente ci-test non trovato'); return; }
  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', (memberships||[]).map(m=>m.company_id));
  const companyId = (companies || []).find(c => c.name === 'MSCedilizia')?.id;
  check('Company di test MSCedilizia trovata', !!companyId, companies);

  const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
  const { data: session } = await anon.auth.signInWithPassword({ email: 'ci-test@palladia.internal', password: tempPassword });
  const jwt = session?.session?.access_token;

  const siteName = `TEST-E2E-ExportFilter-${crypto.randomUUID().slice(0,8)}`;
  const { data: site } = await admin.from('sites').insert({
    company_id: companyId, name: siteName, address: 'Via Test Export', status: 'attivo',
    latitude: 44.4056, longitude: 8.9463, weather_rain_mm: 1, weather_wind_kmh: 50, weather_snow: true, weather_thunderstorm: true,
  }).select('id').single();
  const siteId = site.id;

  // 4 giorni: 2 con soglia superata, 2 sereni — se il filtro funziona,
  // l'export con ?filter=critical deve contenere SOLO i 2 con soglia superata.
  await admin.from('site_weather_logs').insert([
    { company_id: companyId, site_id: siteId, log_date: '2026-06-01', precipitation_mm: 0, wind_max_kmh: 10, weather_code: 0, weather_desc: 'sereno', threshold_exceeded: false, suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified', fetched_at: new Date().toISOString() },
    { company_id: companyId, site_id: siteId, log_date: '2026-06-02', precipitation_mm: 20, wind_max_kmh: 10, weather_code: 65, weather_desc: 'pioggia intensa', threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified', fetched_at: new Date().toISOString() },
    { company_id: companyId, site_id: siteId, log_date: '2026-06-03', precipitation_mm: 0, wind_max_kmh: 10, weather_code: 0, weather_desc: 'sereno', threshold_exceeded: false, suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified', fetched_at: new Date().toISOString() },
    { company_id: companyId, site_id: siteId, log_date: '2026-06-04', precipitation_mm: 25, wind_max_kmh: 10, weather_code: 65, weather_desc: 'pioggia intensa', threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified', fetched_at: new Date().toISOString() },
  ]);

  try {
    // Senza filtro: deve contenere tutti e 4.
    const resAll = await fetch(`${BASE}/api/v1/sites/${siteId}/weather-report.xlsx`, {
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
    });
    check('export senza filtro -> 200', resAll.status === 200, resAll.status);
    const wbAll = new ExcelJS.Workbook();
    await wbAll.xlsx.load(await resAll.arrayBuffer());
    const rowsAll = wbAll.getWorksheet('Dettaglio').rowCount - 1; // -1 header
    check('export senza filtro contiene tutti e 4 i giorni', rowsAll === 4, rowsAll);

    // Con filtro critical: deve contenere SOLO i 2 con soglia superata.
    const resFiltered = await fetch(`${BASE}/api/v1/sites/${siteId}/weather-report.xlsx?filter=critical`, {
      headers: { Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
    });
    check('export con ?filter=critical -> 200', resFiltered.status === 200, resFiltered.status);
    const wbFiltered = new ExcelJS.Workbook();
    await wbFiltered.xlsx.load(await resFiltered.arrayBuffer());
    const wsFiltered = wbFiltered.getWorksheet('Dettaglio');
    const dataRowsFiltered = wsFiltered.rowCount - 1;
    check('export con ?filter=critical contiene SOLO i 2 giorni con soglia superata (non tutti e 4)', dataRowsFiltered === 2, dataRowsFiltered);

    const dates = [];
    for (let i = 2; i <= wsFiltered.rowCount; i++) dates.push(wsFiltered.getRow(i).getCell(1).value);
    check('i 2 giorni esportati sono davvero quelli con soglia superata (2026-06-02 e 2026-06-04, non 06-01 o 06-03)',
      dates.every(d => String(d).includes('2026-06-02') || String(d).includes('2026-06-04')), dates);
  } finally {
    await admin.from('site_weather_logs').delete().eq('site_id', siteId);
    await admin.from('sites').delete().eq('id', siteId);
  }
}

async function main() {
  console.log('\nPalladia regression — export filtrato + icone Phosphor nel Registro Meteo (F-199)');
  block1Pure();
  await block2LiveExportFilter();
  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
