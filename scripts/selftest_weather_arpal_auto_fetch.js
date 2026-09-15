#!/usr/bin/env node
/**
 * scripts/selftest_weather_arpal_auto_fetch.js
 *
 * Regressione per F-199 (AUDIT.md), seconda parte: dopo aver spedito
 * l'upload manuale del CSV ARPAL, il titolare ha corretto la direzione
 * vedendolo in produzione — "non devo caricare io i dati Arpal, devono
 * essere presi in automatico da open meteo ecc" (stesso automatismo già in
 * uso per Open-Meteo/ERA5, non un'azione manuale per cantiere).
 *
 * Copre: geocodifica stazione più vicina (lib/arpalStations.js), fallback
 * su stazioni senza il sensore richiesto (services/arpalWeatherSource.js —
 * scoperto dal vivo: GENOVA - UNIVERSITA' non ha un pluviometro, la
 * stazione più vicina a un cantiere reale NON è sempre quella giusta), e il
 * cron end-to-end (services/weatherArpalCron.js) contro Supabase reale.
 *
 * Blocco 1 (puro): findNearestArpalStation/s — matematica di distanza.
 * Blocco 2 (live, portale ARPAL reale): resolveArpalPrecipitation su una
 * coordinata la cui stazione più vicina è nota per non avere dati di
 * precipitazione — verifica il fallback automatico sulla successiva.
 * Blocco 3 (live, Supabase + portale ARPAL reali): semina un cantiere di
 * test con un log NON ancora certificato, esegue runWeatherArpalCron() per
 * davvero, verifica lo stato nel DB dopo (non solo che non lanci eccezioni).
 * Blocco 4 (puro): il titolare ha visto in produzione, sulla scheda Meteo di
 * Corso Ugo Bassi 28 (tutte le righe già arpal_certified), la vecchia
 * etichetta statica "Open-Meteo / ERA5 (ECMWF)" — "dovrebbe esserci scritto
 * solo ARPAL, è così che guadagniamo la fiducia di tutti". La stessa
 * etichetta generica ("ERA5"/"stima", mai "ARPAL") era scritta anche nel
 * PDF/Excel esportato (services/weatherReport.js) e nella nota automatica
 * scritta su site_suspension_days.notes al momento della conferma
 * (routes/v1/siteWeather.js POST .../confirm) — un documento legale.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { findNearestArpalStation, findNearestArpalStations } = require('../lib/arpalStations');
const { resolveArpalPrecipitation } = require('../services/arpalWeatherSource');
const { generateWeatherReportHtml, generateWeatherReportXlsx } = require('../services/weatherReport');
const { runWeatherArpalCron } = require('../services/weatherArpalCron');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function block1Pure() {
  console.log('\nBlocco 1 — geocodifica stazione ARPAL più vicina (puro, nessuna rete)\n');

  // Corso Ugo Bassi 28 (cantiere reale citato dal titolare per il bug F-199).
  const nearest = findNearestArpalStation(44.419934, 8.923726);
  check('trova una stazione entro 30km da un cantiere reale a Genova', !!nearest, nearest);
  check('la stazione più vicina è davvero la più vicina (< 1km, zona centro Genova)', nearest && nearest.distance_m < 1000, nearest);

  const top5 = findNearestArpalStations(44.419934, 8.923726, 5);
  check('restituisce fino a 5 candidate in ordine di distanza crescente', top5.length === 5 && top5.every((s, i) => i === 0 || s.distance_m >= top5[i-1].distance_m), top5);

  // Coordinata in mezzo al mare (nessuna stazione a terra vicina) — non deve esplodere, deve restituire [].
  const noStation = findNearestArpalStations(43.0, 9.5, 5); // Mar Ligure aperto
  check('nessuna stazione entro raggio utile in mare aperto: lista vuota, non un errore', Array.isArray(noStation) && noStation.length === 0, noStation);
}

async function block2LiveFallback() {
  console.log('\nBlocco 2 — fallback automatico su stazione senza sensore (live, portale ARPAL reale)\n');

  if (process.env.SKIP_ARPAL_LIVE) { skip('fallback stazione ARPAL', 'SKIP_ARPAL_LIVE impostato'); return; }

  try {
    // Scoperto dal vivo durante l'implementazione: GENOVA - UNIVERSITA'
    // (ME00160, la più vicina a Corso Ugo Bassi 28) non ha un pluviometro —
    // il portale risponde "Nessun dato disponibile". resolveArpalPrecipitation
    // deve saltare a GENOVA - CASTELLACCIO (o altra stazione valida) da sola.
    const result = await resolveArpalPrecipitation(44.419934, 8.923726, '2026-09-01', '2026-09-10');
    check('risolve una stazione CON dati reali, non quella più vicina senza sensore', result.stationCode !== 'ME00160', result);
    check('restituisce righe di precipitazione reali', Array.isArray(result.rows) && result.rows.length === 10, result.rows?.length);
    check('nome stazione valorizzato', typeof result.stationName === 'string' && result.stationName.length > 0, result.stationName);
  } catch (err) {
    fail('resolveArpalPrecipitation su un cantiere reale', err.message);
  }
}

async function block3LiveCron() {
  console.log('\nBlocco 3 — runWeatherArpalCron() end-to-end (live, Supabase + portale ARPAL reali)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) { skip('cron ARPAL live', 'fixture Supabase non configurate'); return; }
  if (process.env.SKIP_ARPAL_LIVE) { skip('cron ARPAL live', 'SKIP_ARPAL_LIVE impostato'); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find(u => u.email === 'ci-test@palladia.internal');
  if (!user) { skip('cron ARPAL live', 'utente ci-test non trovato'); return; }
  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', (memberships||[]).map(m=>m.company_id));
  const companyId = (companies || []).find(c => c.name === 'MSCedilizia')?.id;
  check('Company di test MSCedilizia trovata', !!companyId, companies);

  // Stessa posizione di Corso Ugo Bassi 28 — zona con stazioni ARPAL note e
  // verificate in questo file (evita coordinate a caso senza copertura).
  const siteName = `TEST-E2E-ArpalAutoFetch-${crypto.randomUUID().slice(0,8)}`;
  const { data: site } = await admin.from('sites').insert({
    company_id: companyId, name: siteName, address: 'Via Test ARPAL Auto', status: 'attivo',
    latitude: 44.419934, longitude: 8.923726, weather_rain_mm: 1, weather_wind_kmh: 50, weather_snow: true, weather_thunderstorm: true,
  }).select('id').single();
  const siteId = site.id;

  // Un giorno recente MAI certificato ARPAL (stima ERA5 volutamente diversa
  // dal dato reale, per verificare che venga davvero sovrascritto) + un
  // giorno già CONFERMATO da un umano (il verdetto non deve toccarsi).
  await admin.from('site_weather_logs').insert([
    { company_id: companyId, site_id: siteId, log_date: '2026-09-03', precipitation_mm: 0, wind_max_kmh: 12, weather_code: 2, weather_desc: 'parzialmente nuvoloso', threshold_exceeded: false, threshold_reason: null, suspension_confirmed: false, suspension_dismissed: false, data_source: 'era5_confirmed', fetched_at: new Date().toISOString() },
    { company_id: companyId, site_id: siteId, log_date: '2026-09-05', precipitation_mm: 0, wind_max_kmh: 12, weather_code: 2, weather_desc: 'parzialmente nuvoloso', threshold_exceeded: false, threshold_reason: null, suspension_confirmed: true, suspension_dismissed: false, data_source: 'era5_confirmed', fetched_at: new Date().toISOString() },
  ]);

  try {
    await runWeatherArpalCron();

    const { data: rows } = await admin.from('site_weather_logs')
      .select('log_date, precipitation_mm, wind_max_kmh, data_source, arpal_station_name, threshold_exceeded, era5_discrepancy')
      .eq('site_id', siteId).order('log_date');

    const undecided = rows.find(r => r.log_date === '2026-09-03');
    check('giorno mai deciso: data_source diventa arpal_certified nel DB, senza alcuna azione manuale', undecided?.data_source === 'arpal_certified', undecided);
    check('giorno mai deciso: arpal_station_name valorizzato automaticamente', !!undecided?.arpal_station_name, undecided);
    check('giorno mai deciso: wind_max_kmh preservato da ERA5 (12), non azzerato dal merge', Number(undecided?.wind_max_kmh) === 12, undecided);

    const decided = rows.find(r => r.log_date === '2026-09-05');
    check('giorno già confermato: threshold_exceeded NEL DB resta false (verdetto intoccato dal cron automatico)', decided?.threshold_exceeded === false, decided);
    check('giorno già confermato: il dato grezzo si aggiorna comunque (data_source cambia)', decided?.data_source === 'arpal_certified', decided);
  } finally {
    await admin.from('site_weather_logs').delete().eq('site_id', siteId);
    await admin.from('sites').delete().eq('id', siteId);
  }
}

function block4ReportLabels() {
  console.log('\nBlocco 4 — PDF/Excel/nota conferma dicono "ARPAL", non più "Open-Meteo / ERA5" genericamente (puro, nessuna rete)\n');

  const site = { name: 'TEST-Cantiere', start_date: '2026-08-01', end_date: '2026-10-30' };
  const thresholds = { rain_mm: 1, wind_kmh: 50, snow: true, thunderstorm: true };
  const rows = [
    { log_date: '2026-08-01', precipitation_mm: 14.6, wind_max_kmh: 10, temp_min_c: 18, temp_max_c: 24, weather_desc: 'pioggia intensa', weather_code: 65, threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified', arpal_station_name: 'GENOVA - CENTRO FUNZIONALE', era5_discrepancy: false },
    { log_date: '2026-08-02', precipitation_mm: 0.5, wind_max_kmh: 8, temp_min_c: 20, temp_max_c: 27, weather_desc: 'pioggerella', weather_code: 51, threshold_exceeded: false, threshold_reason: null, suspension_confirmed: false, suspension_dismissed: false, data_source: 'forecast_preliminary', era5_discrepancy: false },
  ];

  const html = generateWeatherReportHtml({ site, rows, thresholds });
  check('PDF: la riga certificata ARPAL mostra "ARPAL" in colonna Fonte', /<td class="td-center">ARPAL<\/td>/.test(html), html.match(/<td class="td-center">ARPAL<\/td>/));
  check('PDF: nessun riferimento generico a "Open-Meteo / ERA5 (ECMWF)" come unica fonte', !html.includes('Open-Meteo / ERA5 (ECMWF)'), true);
  check('PDF: la nota fonte cita ARPAL come standard CIGO/INPS', /ARPAL/.test(html) && /circolare n\. 139/.test(html), true);

  const wb = generateWeatherReportXlsx({ site, rows, thresholds });
  const ws2 = wb.getWorksheet('Dettaglio');
  const arpalRow = ws2.getRow(2); // riga 1 = header, riga 2 = prima riga dati (2026-08-01, arpal_certified)
  check('Excel: riga certificata ARPAL mostra "ARPAL certificato" in colonna Fonte', String(arpalRow.getCell(10).value).startsWith('ARPAL certificato'), arpalRow.getCell(10).value);
  const ws1 = wb.getWorksheet('Riepilogo');
  const fonteDatiRow = ws1.getRows(1, ws1.rowCount)?.find(r => r.getCell(1).value === 'Fonte dati');
  check('Excel: "Fonte dati" nel Riepilogo cita ARPAL, non più solo Open-Meteo/ERA5', /ARPAL/.test(String(fonteDatiRow?.getCell(2).value)), fonteDatiRow?.getCell(2).value);
}

async function main() {
  console.log('\nPalladia regression — fetch automatico ARPAL, nessun upload manuale (F-199)');
  block1Pure();
  await block2LiveFallback();
  await block3LiveCron();
  block4ReportLabels();
  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
