#!/usr/bin/env node
/**
 * scripts/selftest_weather_history_backfill.js
 *
 * Test di regressione per F-207 (AUDIT.md) — il backfill storico meteo
 * (ERA5, dall'inizio cantiere a ieri) non partiva mai per la stragrande
 * maggioranza dei cantieri reali.
 *
 * Causa: il frontend (SiteWeatherSection.tsx) faceva partire il backfill
 * automatico SOLO quando la scheda Meteo veniva aperta con `logs.length ===
 * 0`. Ma services/weatherLogCron.js scrive "il meteo di ieri" per ogni
 * cantiere con GPS OGNI GIORNO, indipendentemente da chi apre l'app — quindi
 * quando un utente apriva per la prima volta la scheda Meteo di un cantiere
 * già esistente da mesi, il cron aveva quasi sempre già scritto almeno una
 * riga (quella di ieri), la condizione "zero righe" non era mai vera, e il
 * buco fra `start_date` e la prima riga scritta dal cron restava per sempre
 * senza stima ERA5 — e quindi mai certificato ARPAL (weatherArpalCron.js
 * certifica solo righe GIÀ esistenti, non ne crea).
 *
 * Osservato sui dati reali di MSCedilizia S.r.l.: Via Riboli 4b
 * (start_date 2025-09-18) aveva la prima riga meteo solo dal 2026-05-23 —
 * 8 mesi di storico mancanti.
 *
 * Questo test simula esattamente quella race condition: crea un cantiere
 * con start_date nel passato, inserisce UNA SOLA riga meteo (quella che il
 * cron avrebbe già scritto per "ieri" prima che l'utente aprisse la scheda),
 * poi fa girare processCompany() — la stessa funzione del cron reale — e
 * verifica che il buco venga colmato.
 *
 * Nessun mock: getWeatherRange() chiama Open-Meteo (API pubblica gratuita,
 * nessuna chiave) come farebbe il cron in produzione.
 *
 * Env: nessuna credenziale richiesta oltre a SUPABASE_SERVICE_ROLE_KEY
 * (già in .env per ogni selftest di questo repo).
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { processCompany } = require('../services/weatherLogCron');
const { hasWeatherHistoryGap } = require('../services/weatherBackfill');

const COMPANY_ID = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
// Genova centro — stessa area usata dagli altri selftest meteo di questo repo.
const LAT = 44.4056, LON = 8.9463;

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }

const TZ = 'Europe/Rome';
function isoDaysAgo(n) {
  const d = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: TZ }));
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function main() {
  console.log('\n\x1b[1mBackfill storico meteo — buco cron/frontend (F-207)\x1b[0m');

  const startDate = isoDaysAgo(120); // "il cantiere è iniziato" 120 giorni fa
  const yesterday = isoDaysAgo(1);

  const { data: site, error: siteErr } = await supabase.from('sites').insert({
    company_id: COMPANY_ID, name: `TEST-F207 Cantiere ${Date.now()}`, status: 'attivo',
    address: 'Via Test 207, Genova', latitude: LAT, longitude: LON, start_date: startDate,
  }).select('id, name, address, start_date, latitude, longitude, weather_rain_mm, weather_wind_kmh, weather_snow, weather_thunderstorm').single();
  if (siteErr) { fail('crea cantiere di test', siteErr.message); return report(); }

  // Simula ESATTAMENTE la race condition: il cron ha già scritto "ieri"
  // prima che chiunque aprisse la scheda Meteo — un giorno pendente da
  // confermare, umanamente non ancora deciso.
  const { error: insErr } = await supabase.from('site_weather_logs').insert({
    company_id: COMPANY_ID, site_id: site.id, log_date: yesterday,
    precipitation_mm: 0, wind_max_kmh: 5, temp_min_c: 15, temp_max_c: 22,
    weather_code: 0, weather_desc: 'sereno', threshold_exceeded: false,
    suspension_confirmed: false, suspension_dismissed: false,
    data_source: 'forecast_preliminary', fetched_at: new Date().toISOString(),
  });
  if (insErr) { fail('inserisci riga meteo preesistente (simula il cron)', insErr.message); await cleanup(site.id); return report(); }

  try {
    // 1. Il buco deve essere rilevato: start_date è 120 giorni fa, l'unica
    //    riga esistente è di ieri.
    const gapBefore = await hasWeatherHistoryGap(site);
    if (gapBefore) ok('un cantiere con start_date nel passato e una sola riga recente ha un buco rilevato');
    else fail('un cantiere con start_date nel passato e una sola riga recente ha un buco rilevato');

    // 2. Fa girare la STESSA funzione del cron reale (non una simulazione).
    await processCompany(COMPANY_ID, yesterday);

    const { data: logsAfter, error: afterErr } = await supabase
      .from('site_weather_logs')
      .select('log_date, data_source')
      .eq('site_id', site.id)
      .order('log_date', { ascending: true });
    if (afterErr) { fail('rilettura righe dopo processCompany', afterErr.message); }

    const minDate = logsAfter?.[0]?.log_date;
    if (minDate && minDate <= startDate) ok('dopo il cron, la riga più vecchia risale a start_date (buco colmato)');
    else fail('dopo il cron, la riga più vecchia risale a start_date (buco colmato)', { minDate, startDate });

    // ~121 giorni attesi (start_date -> yesterday inclusi).
    const expectedDays = Math.round((new Date(yesterday) - new Date(startDate)) / 86400000) + 1;
    if (logsAfter && logsAfter.length >= expectedDays - 1) ok(`tutti i giorni da start_date a ieri sono stati scritti (${logsAfter.length}/${expectedDays})`);
    else fail(`tutti i giorni da start_date a ieri sono stati scritti (${logsAfter?.length}/${expectedDays})`);

    // 3. La riga già esistente (quella "del cron", non decisa da un umano)
    //    non deve sparire né essere duplicata.
    const yesterdayRows = (logsAfter || []).filter(l => l.log_date === yesterday);
    if (yesterdayRows.length === 1) ok('la riga di "ieri" già presente prima del backfill resta unica (upsert, non duplicata)');
    else fail('la riga di "ieri" già presente prima del backfill resta unica (upsert, non duplicata)', yesterdayRows);

    // 4. Il buco non deve più essere rilevato al giro successivo (idempotente
    //    — non ri-scarica tutto lo storico ogni giorno).
    const gapAfter = await hasWeatherHistoryGap(site);
    if (!gapAfter) ok('il buco non viene più rilevato dopo il backfill (idempotente)');
    else fail('il buco non viene più rilevato dopo il backfill (idempotente)');
  } finally {
    await cleanup(site.id);
  }

  report();
}

async function cleanup(siteId) {
  await supabase.from('site_weather_logs').delete().eq('site_id', siteId);
  await supabase.from('notifications').delete().eq('entity_id', siteId).eq('entity_type', 'site');
  await supabase.from('sites').delete().eq('id', siteId);
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_weather_history_backfill:', e.message);
  process.exit(1);
});
