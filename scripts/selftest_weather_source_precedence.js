#!/usr/bin/env node
/**
 * scripts/selftest_weather_source_precedence.js
 *
 * Regressione per F-200 (AUDIT.md): trovato continuando lo sweep di F-199,
 * non segnalato dal titolare. buildWeatherLogUpdate (services/weatherService.js)
 * sovrascriveva SEMPRE data_source/precipitation_mm/wind_max_kmh/weather_code
 * col dato appena ricevuto, senza mai controllare se la fonte già in DB fosse
 * più autorevole (arpal_certified > era5_confirmed > forecast_preliminary).
 * Le due crontab automatiche sono protette per costruzione (filtrano a monte
 * per data_source), ma i due pulsanti manuali — "Aggiorna ieri"
 * (POST /weather-log/fetch) e "Carica storico" (POST /weather-log/backfill)
 * in routes/v1/siteWeather.js — chiamavano buildWeatherLogUpdate senza
 * nessun filtro: un giorno già certificato ARPAL (dato che finisce in
 * tribunale) poteva tornare silenziosamente una stima Open-Meteo.
 *
 * Blocco 1 (puro): buildWeatherLogUpdate — riproduce esattamente i due
 * scenari verificati dal vivo durante l'audit (giorno non deciso, giorno già
 * confermato) e verifica che né data_source né precipitation_mm regrediscano
 * mai verso una fonte meno autorevole. Verifica anche groupRowsByShape.
 * Blocco 2 (live HTTP, Supabase + backend reali): crea un log arpal_certified
 * di test, chiama POST /weather-log/fetch con lo stesso JWT/company-id
 * dell'app sulla stessa data, verifica nel DB che il dato resti ARPAL
 * invariato dopo la chiamata (non un ragionamento sul diff). Verifica anche
 * che la risposta porti blocked:true — il frontend lo usa per non mostrare
 * "Dati meteo aggiornati" quando non è cambiato nulla davvero (vedi
 * src/test/weather-fetch-blocked-toast.test.ts nel repo frontend).
 * Blocco 3 (live HTTP): stessa idea su POST /weather-log/backfill — un
 * cantiere con un solo giorno già arpal_certified nel range verifica che la
 * risposta distingua "updated" (giorni scritti davvero) da "unchanged"
 * (giorni già certificati, non toccati) invece del solo "inserted" totale,
 * che prima del fix il frontend leggeva come "N giorni caricati" anche
 * quando la maggior parte erano invariati.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { buildWeatherLogUpdate, groupRowsByShape, dataSourceRank } = require('../services/weatherService');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

function block1Pure() {
  console.log('\nBlocco 1 — buildWeatherLogUpdate: precedenza tra fonti (puro, nessuna rete)\n');

  check('dataSourceRank: arpal_certified > era5_confirmed > forecast_preliminary',
    dataSourceRank('arpal_certified') > dataSourceRank('era5_confirmed') && dataSourceRank('era5_confirmed') > dataSourceRank('forecast_preliminary'),
    { arpal: dataSourceRank('arpal_certified'), era5: dataSourceRank('era5_confirmed'), forecast: dataSourceRank('forecast_preliminary') });

  const thresholds = { rain_mm: 1, wind_kmh: 50, snow: true, thunderstorm: true };

  // Scenario 1 (esatto, riprodotto dal vivo durante l'audit): giorno NON
  // deciso, già arpal_certified, "Aggiorna ieri" arriva con una stima
  // preliminare più vecchia.
  {
    const existing = { suspension_confirmed: false, suspension_dismissed: false, threshold_exceeded: true, precipitation_mm: 88.6, wind_max_kmh: 20, weather_code: 65, data_source: 'arpal_certified' };
    const stale = { precipitation_mm: 0.2, wind_max_kmh: 5, weather_code: 51, temp_min: 18, temp_max: 24, weather_desc: 'pioggerella', data_source: 'forecast_preliminary' };
    const update = buildWeatherLogUpdate(existing, stale, thresholds);

    check('giorno non deciso: data_source NON regredisce da arpal_certified a forecast_preliminary', update.data_source !== 'forecast_preliminary', update);
    check('giorno non deciso: precipitation_mm certificata (88.6) non sovrascritta da una stima (0.2)', update.precipitation_mm !== 0.2, update);
    check('giorno non deciso: threshold_exceeded non declassato a false da un dato meno autorevole', update.threshold_exceeded !== false, update);
    check('nessun campo grezzo è entrato nell\'update bloccato (solo fetched_at)', Object.keys(update).every(k => k === 'fetched_at'), update);
  }

  // Scenario 2: giorno GIÀ CONFERMATO da un umano, stessa fonte inferiore in arrivo.
  {
    const existing = { suspension_confirmed: true, suspension_dismissed: false, threshold_exceeded: true, precipitation_mm: 88.6, wind_max_kmh: 20, weather_code: 65, data_source: 'arpal_certified' };
    const stale = { precipitation_mm: 0.2, wind_max_kmh: 5, weather_code: 51, temp_min: 18, temp_max: 24, weather_desc: 'pioggerella', data_source: 'forecast_preliminary' };
    const update = buildWeatherLogUpdate(existing, stale, thresholds);

    check('giorno confermato: data_source resta intoccato (non solo threshold_exceeded)', update.data_source !== 'forecast_preliminary', update);
    check('giorno confermato: precipitation_mm certificata non sovrascritta', update.precipitation_mm !== 0.2, update);
    check('giorno confermato: nessun era5_discrepancy fantasma su un update bloccato', !('era5_discrepancy' in update), update);
  }

  // Scenario 3 — controllo negativo: una fonte MIGLIORE deve poter sempre
  // aggiornare (ERA5 su preliminare, ARPAL su ERA5) — il fix non deve
  // bloccare gli aggiornamenti legittimi.
  {
    const existing = { suspension_confirmed: false, suspension_dismissed: false, threshold_exceeded: false, precipitation_mm: 0.2, wind_max_kmh: 5, weather_code: 51, data_source: 'forecast_preliminary' };
    const better = { precipitation_mm: 12, wind_max_kmh: 10, weather_code: 63, temp_min: 15, temp_max: 20, weather_desc: 'pioggia moderata', data_source: 'era5_confirmed' };
    const update = buildWeatherLogUpdate(existing, better, thresholds);
    check('ERA5 aggiorna correttamente una stima preliminare (nessun blocco su un upgrade legittimo)', update.data_source === 'era5_confirmed' && update.precipitation_mm === 12, update);
    check('upgrade legittimo: precipitation_mm_original preservato (0.2, il valore preliminare pre-riconciliazione)', update.precipitation_mm_original === 0.2, update);
  }

  // Scenario 4 — stessa fonte due volte (es. un secondo backfill ARPAL sullo
  // stesso giorno): non è una regressione, deve applicarsi normalmente.
  {
    const existing = { suspension_confirmed: false, suspension_dismissed: false, threshold_exceeded: true, precipitation_mm: 5, wind_max_kmh: 5, weather_code: 61, data_source: 'arpal_certified' };
    const same = { precipitation_mm: 5, wind_max_kmh: 5, weather_code: 61, temp_min: 15, temp_max: 20, weather_desc: 'pioggia', data_source: 'arpal_certified' };
    const update = buildWeatherLogUpdate(existing, same, thresholds);
    check('stessa fonte ripetuta: si applica normalmente, non trattata come downgrade', update.data_source === 'arpal_certified' && update.precipitation_mm === 5, update);
  }

  // Blocco 1b — groupRowsByShape: il batch upsert di /weather-log/backfill
  // ora può avere fino a 3 forme diverse (non decisa, decisa, bloccata).
  {
    const rows = [
      { site_id: 'a', log_date: '2026-01-01', threshold_exceeded: true, threshold_reason: 'pioggia', data_source: 'era5_confirmed' },
      { site_id: 'a', log_date: '2026-01-02', data_source: 'era5_confirmed' }, // decisa, no threshold_*
      { site_id: 'a', log_date: '2026-01-03', fetched_at: '2026-01-03T00:00:00Z' }, // bloccata (downgrade)
      { site_id: 'a', log_date: '2026-01-04', threshold_exceeded: false, threshold_reason: null, data_source: 'era5_confirmed' },
    ];
    const groups = groupRowsByShape(rows);
    check('groupRowsByShape: 3 forme diverse -> 3 gruppi', groups.length === 3, groups.map(g => g.length));
    check('groupRowsByShape: righe con la stessa forma finiscono nello stesso gruppo', groups.some(g => g.length === 2), groups.map(g => g.map(r => r.log_date)));
    check('groupRowsByShape: nessuna riga persa', groups.reduce((n, g) => n + g.length, 0) === rows.length, groups);
  }
}

async function block2LiveHttpFetchDoesNotDowngrade() {
  console.log('\nBlocco 2 — POST /weather-log/fetch non declassa un giorno già arpal_certified (live HTTP)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) { skip('fetch non declassa ARPAL', 'fixture Supabase non configurate'); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find(u => u.email === 'ci-test@palladia.internal');
  if (!user) { skip('fetch non declassa ARPAL', 'utente ci-test non trovato'); return; }
  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', (memberships || []).map(m => m.company_id));
  const companyId = (companies || []).find(c => c.name === 'MSCedilizia')?.id;
  if (!companyId) { skip('fetch non declassa ARPAL', 'company MSCedilizia non trovata'); return; }

  const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
  const { data: session } = await anon.auth.signInWithPassword({ email: 'ci-test@palladia.internal', password: tempPassword });
  const jwt = session?.session?.access_token;

  const siteName = `TEST-E2E-F200-SourcePrecedence-${crypto.randomUUID().slice(0, 8)}`;
  // Roma centro — coordinate qualsiasi, "Aggiorna ieri" userà Open-Meteo
  // (irrilevante al test: quello che conta è che il valore ARPAL esistente
  // non si muova, qualunque cosa risponda Open-Meteo per ieri).
  const { data: site } = await admin.from('sites').insert({
    company_id: companyId, name: siteName, address: 'Via Test F-200', status: 'attivo',
    latitude: 41.9028, longitude: 12.4964, weather_rain_mm: 1, weather_wind_kmh: 50, weather_snow: true, weather_thunderstorm: true,
  }).select('id').single();
  const siteId = site.id;

  const yesterday = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }));
  yesterday.setDate(yesterday.getDate() - 1);
  const dateISO = yesterday.toISOString().split('T')[0];

  await admin.from('site_weather_logs').insert({
    company_id: companyId, site_id: siteId, log_date: dateISO,
    precipitation_mm: 42.5, wind_max_kmh: 8, weather_code: 63, weather_desc: 'pioggia moderata',
    threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false,
    data_source: 'arpal_certified', arpal_station_name: 'TEST-F200', fetched_at: new Date().toISOString(),
  });

  try {
    const res = await fetch(`${BASE}/api/v1/sites/${siteId}/weather-log/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
      body: JSON.stringify({ dates: [dateISO] }),
    });
    check('POST /weather-log/fetch -> 200', res.status === 200, res.status);
    const body = await res.json();
    // F-200 (AUDIT.md): il frontend usa "blocked" per non mostrare "Dati
    // meteo aggiornati" quando il backend non ha in realtà toccato nulla —
    // src/test/weather-fetch-blocked-toast.test.ts (frontend) copre la
    // logica del toast, questo verifica che il backend valorizzi il campo
    // che quella logica legge.
    check('risposta include blocked:true per il giorno già certificato ARPAL', body?.results?.[0]?.blocked === true, body);

    const { data: row } = await admin.from('site_weather_logs')
      .select('data_source, precipitation_mm, threshold_exceeded, arpal_station_name')
      .eq('site_id', siteId).eq('log_date', dateISO).single();

    check('dopo "Aggiorna ieri": data_source resta arpal_certified (non declassato a forecast_preliminary)', row?.data_source === 'arpal_certified', row);
    check('dopo "Aggiorna ieri": precipitation_mm certificata (42.5) non sovrascritta da una stima Open-Meteo', Number(row?.precipitation_mm) === 42.5, row);
    check('dopo "Aggiorna ieri": threshold_exceeded resta true', row?.threshold_exceeded === true, row);
    check('dopo "Aggiorna ieri": arpal_station_name resta quello certificato', row?.arpal_station_name === 'TEST-F200', row);
  } finally {
    await admin.from('site_weather_logs').delete().eq('site_id', siteId);
    await admin.from('sites').delete().eq('id', siteId);
  }
}

async function block3LiveHttpBackfillReportsHonestCounts() {
  console.log('\nBlocco 3 — POST /weather-log/backfill separa giorni davvero scritti da giorni già certificati (live HTTP)\n');

  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) { skip('backfill conteggio onesto', 'fixture Supabase non configurate'); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find(u => u.email === 'ci-test@palladia.internal');
  if (!user) { skip('backfill conteggio onesto', 'utente ci-test non trovato'); return; }
  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', (memberships || []).map(m => m.company_id));
  const companyId = (companies || []).find(c => c.name === 'MSCedilizia')?.id;
  if (!companyId) { skip('backfill conteggio onesto', 'company MSCedilizia non trovata'); return; }

  const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
  const { data: session } = await anon.auth.signInWithPassword({ email: 'ci-test@palladia.internal', password: tempPassword });
  const jwt = session?.session?.access_token;

  const siteName = `TEST-E2E-F200-BackfillCounts-${crypto.randomUUID().slice(0, 8)}`;
  const startDate = '2026-09-01';
  const { data: site } = await admin.from('sites').insert({
    company_id: companyId, name: siteName, address: 'Via Test F-200 Backfill', status: 'attivo', start_date: startDate,
    latitude: 41.9028, longitude: 12.4964, weather_rain_mm: 1, weather_wind_kmh: 50, weather_snow: true, weather_thunderstorm: true,
  }).select('id').single();
  const siteId = site.id;

  // Un solo giorno del range già arpal_certified — il resto va scritto ex novo.
  await admin.from('site_weather_logs').insert({
    company_id: companyId, site_id: siteId, log_date: startDate,
    precipitation_mm: 5, wind_max_kmh: 5, weather_code: 61, weather_desc: 'pioggia',
    threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false,
    data_source: 'arpal_certified', arpal_station_name: 'TEST-F200', fetched_at: new Date().toISOString(),
  });

  try {
    const res = await fetch(`${BASE}/api/v1/sites/${siteId}/weather-log/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
    });
    check('POST /weather-log/backfill -> 200', res.status === 200, res.status);
    const body = await res.json();

    check('risposta include "updated" distinto da "inserted"', typeof body.updated === 'number' && typeof body.inserted === 'number', body);
    check('"unchanged" conta almeno il giorno già arpal_certified seminato', (body.unchanged ?? 0) >= 1, body);
    check('inserted === updated + unchanged (nessun giorno perso nel conteggio)', body.inserted === body.updated + body.unchanged, body);

    const { data: seedRow } = await admin.from('site_weather_logs')
      .select('data_source, precipitation_mm')
      .eq('site_id', siteId).eq('log_date', startDate).single();
    check('il giorno seminato arpal_certified resta invariato dopo il backfill', seedRow?.data_source === 'arpal_certified' && Number(seedRow?.precipitation_mm) === 5, seedRow);
  } finally {
    await admin.from('site_weather_logs').delete().eq('site_id', siteId);
    await admin.from('sites').delete().eq('id', siteId);
  }
}

async function main() {
  console.log('\nPalladia regression — precedenza fonte dato meteo (F-200)');
  block1Pure();
  await block2LiveHttpFetchDoesNotDowngrade();
  await block3LiveHttpBackfillReportsHonestCounts();
  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
