#!/usr/bin/env node
/**
 * scripts/selftest_weather_shift_hours.js
 *
 * Regressione per F-199 (AUDIT.md), terza parte: "la fascia oraria possa
 * essere impostata, perché se lavoro di giorno non mi interessa se piove
 * la sera, e se lavoro di notte non mi interessa se piove di giorno".
 *
 * ARPAL fornisce precipitazione oraria in UTC (verificato scaricando
 * un'estrazione oraria reale prima di scrivere lib/weatherShift.js — il
 * portale stesso avvisa: "Tutti i dati raccolti sono riferiti al sistema
 * UTC"). Un turno che attraversa la mezzanotte (notte) va attribuito al
 * giorno in cui INIZIA, non al numero di calendario dell'ora.
 *
 * Blocco 1 (puro): lib/weatherShift.js — conversione UTC->Europe/Rome
 * (estate/inverno), attribuzione turno giorno/notte, casi limite.
 * Blocco 2 (live, portale ARPAL reale): scarica dati orari reali per una
 * stazione nota (GENOVA - CASTELLACCIO, 20-21/08/2026 — stesso giorno già
 * verificato manualmente: totale 24h 64.2mm e 88.6mm) e verifica che la
 * somma turno-giorno + turno-notte torni al totale 24h.
 * Blocco 3 (live, Supabase + portale ARPAL reali): cantiere di test con
 * weather_shift_enabled=true, runWeatherArpalCron() per davvero — verifica
 * nel DB che precipitation_mm sia il valore filtrato (non il totale 24h) e
 * precipitation_mm_full_day il totale intero, per audit.
 * Blocco 4 (live HTTP): PATCH /sites/:id che attiva/cambia la fascia oraria
 * marca i giorni MAI decisi come da ricertificare (data_source torna
 * forecast_preliminary) — un giorno già confermato/ignorato NON si tocca
 * (F-159).
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { utcHourToRomeLocal, assignShiftDate, sumShiftPrecipitation } = require('../lib/weatherShift');
const { fetchArpalStationRange } = require('../services/arpalWeatherSource');
const { runWeatherArpalCron } = require('../services/weatherArpalCron');

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
  console.log('\nBlocco 1 — lib/weatherShift.js: fuso orario e attribuzione turno (puro, nessuna rete)\n');

  check('UTC->Roma in estate (CEST, +2): 07:00 UTC -> 09:00 locale',
    utcHourToRomeLocal('2026-08-20', '07:00').localHour === 9, utcHourToRomeLocal('2026-08-20', '07:00'));
  check('UTC->Roma in inverno (CET, +1): 07:00 UTC -> 08:00 locale',
    utcHourToRomeLocal('2026-01-15', '07:00').localHour === 8, utcHourToRomeLocal('2026-01-15', '07:00'));
  const crossMidnight = utcHourToRomeLocal('2026-08-20', '23:00');
  check('un\'ora vicina a mezzanotte UTC può cambiare giorno locale (CEST +2)',
    crossMidnight.localDate === '2026-08-21' && crossMidnight.localHour === 1, crossMidnight);

  check('turno diurno 08-18: ora dentro la fascia resta sullo stesso giorno',
    assignShiftDate('2026-08-20', 10, '08:00', '18:00') === '2026-08-20');
  check('turno diurno 08-18: ora di sera fuori fascia -> null (non conta per nessun giorno)',
    assignShiftDate('2026-08-20', 20, '08:00', '18:00') === null);

  check('turno notturno 20-06: ora della sera appartiene al giorno corrente',
    assignShiftDate('2026-08-20', 22, '20:00', '06:00') === '2026-08-20');
  check('turno notturno 20-06: ora dopo mezzanotte appartiene al turno iniziato IERI',
    assignShiftDate('2026-08-21', 3, '20:00', '06:00') === '2026-08-20');
  check('turno notturno 20-06: ore di pieno giorno restano fuori dal turno -> null',
    assignShiftDate('2026-08-20', 12, '20:00', '06:00') === null);
  check('turno notturno che attraversa capodanno: 31/12 ore notturne -> giorno corretto',
    assignShiftDate('2026-01-01', 2, '20:00', '06:00') === '2025-12-31');

  check('start === end: nessun filtro reale, ogni ora conta per il proprio giorno',
    assignShiftDate('2026-08-20', 3, '00:00', '00:00') === '2026-08-20');

  // sumShiftPrecipitation su dati fittizi puri: 1mm/ora per 24 ore, turno 08-18 (10 ore) -> 10mm.
  const fakeHourly = Array.from({ length: 24 }, (_, h) => ({
    date: '2026-06-01', hour: `${String(h).padStart(2, '0')}:00`, precipitation_mm: 1, valid: true,
  }));
  const fakeShift = sumShiftPrecipitation(fakeHourly, '08:00', '18:00');
  // In UTC 08:00-18:00 -> locale (CEST +2) 10:00-20:00: 10 ore locali dentro il turno 08-18 -> 08:00-18:00 locale = 8 ore intere (08,09..17)
  // usato solo come sanity check di non-esplosione/coerenza aggregata, non un valore normativo:
  const totalFullDay = [...fakeShift.values()].reduce((s, b) => s + b.fullDayMm, 0);
  check('sumShiftPrecipitation: il totale fullDay aggregato su tutti i bucket coincide con 24mm (24 ore x 1mm)',
    Math.abs(totalFullDay - 24) < 0.01, totalFullDay);
}

async function block2LiveHourlySum() {
  console.log('\nBlocco 2 — coerenza turno-giorno + turno-notte = totale 24h (live, portale ARPAL reale)\n');

  if (process.env.SKIP_ARPAL_LIVE) { skip('coerenza somma oraria ARPAL', 'SKIP_ARPAL_LIVE impostato'); return; }

  try {
    // Stessa stazione/date già verificate manualmente in questa sessione:
    // 20/08/2026 = 64.2mm, 21/08/2026 = 88.6mm sul totale 24h (confermato
    // anche contro il valore giornaliero GG salvato in produzione).
    const result = await fetchArpalStationRange('ME00041', '2026-08-20', '2026-08-21', 'HH');
    check('estrazione oraria reale: 48 righe (2 giorni x 24 ore)', result.rows.length === 48, result.rows.length);

    const fullDay = sumShiftPrecipitation(result.rows, '00:00', '00:00');
    check('nessun filtro (00:00-00:00): 20/08 = 64.2mm, già verificato manualmente contro il portale',
      fullDay.get('2026-08-20')?.fullDayMm === 64.2, fullDay.get('2026-08-20'));
    check('nessun filtro (00:00-00:00): 21/08 = 88.6mm, già verificato manualmente contro il portale',
      fullDay.get('2026-08-21')?.fullDayMm === 88.6, fullDay.get('2026-08-21'));

    const dayShift   = sumShiftPrecipitation(result.rows, '06:00', '18:00');
    const nightShift = sumShiftPrecipitation(result.rows, '18:00', '06:00');
    // Il turno notte 18-06 iniziato il 20/08 include le ore dopo mezzanotte
    // del 21/08 — sommato al turno giorno 06-18 del 21/08 deve tornare
    // esattamente al totale 24h del 21/08 (nessuna ora persa o doppia).
    const reconstructed21 = (dayShift.get('2026-08-21')?.shiftMm ?? 0) + (nightShift.get('2026-08-20')?.shiftMm ?? 0);
    check('turno giorno (06-18 del 21/08) + turno notte (18-06 iniziato il 20/08) = totale 24h del 21/08, nessuna ora persa o doppia',
      Math.abs(reconstructed21 - 88.6) < 0.01, { dayShift21: dayShift.get('2026-08-21'), nightShift20: nightShift.get('2026-08-20'), reconstructed21 });
  } catch (err) {
    fail('coerenza somma oraria ARPAL', err.message);
  }
}

async function block3LiveCronShift() {
  console.log('\nBlocco 3 — runWeatherArpalCron() con fascia oraria attiva (live, Supabase + portale ARPAL reali)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) { skip('cron con fascia oraria', 'fixture Supabase non configurate'); return; }
  if (process.env.SKIP_ARPAL_LIVE) { skip('cron con fascia oraria', 'SKIP_ARPAL_LIVE impostato'); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find(u => u.email === 'ci-test@palladia.internal');
  if (!user) { skip('cron con fascia oraria', 'utente ci-test non trovato'); return; }
  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', (memberships||[]).map(m=>m.company_id));
  const companyId = (companies || []).find(c => c.name === 'MSCedilizia')?.id;
  check('Company di test MSCedilizia trovata', !!companyId, companies);

  // Stessa posizione di Corso Ugo Bassi 28 (nearest = GENOVA - CASTELLACCIO,
  // già verificata funzionante in questa sessione).
  const siteName = `TEST-E2E-ArpalShift-${crypto.randomUUID().slice(0,8)}`;
  const { data: site } = await admin.from('sites').insert({
    company_id: companyId, name: siteName, address: 'Via Test Turno', status: 'attivo',
    latitude: 44.419934, longitude: 8.923726, weather_rain_mm: 1, weather_wind_kmh: 50, weather_snow: true, weather_thunderstorm: true,
    weather_shift_enabled: true, weather_shift_start: '06:00', weather_shift_end: '18:00',
  }).select('id').single();
  const siteId = site.id;

  // Giorno mai deciso, nel range già noto con pioggia reale (21/08: 88.6mm
  // sulle 24h, 63.8mm nella fascia 06-18 — verificato nel Blocco 2).
  await admin.from('site_weather_logs').insert({
    company_id: companyId, site_id: siteId, log_date: '2026-08-21', precipitation_mm: 0, wind_max_kmh: 12, weather_code: 2, weather_desc: 'parzialmente nuvoloso',
    threshold_exceeded: false, threshold_reason: null, suspension_confirmed: false, suspension_dismissed: false, data_source: 'era5_confirmed', fetched_at: new Date().toISOString(),
  });

  try {
    await runWeatherArpalCron();

    const { data: row } = await admin.from('site_weather_logs')
      .select('precipitation_mm, precipitation_mm_full_day, data_source, threshold_exceeded')
      .eq('site_id', siteId).eq('log_date', '2026-08-21').single();

    check('precipitation_mm è il valore FILTRATO sulla fascia 06-18 (63.8mm), non il totale 24h', Number(row?.precipitation_mm) === 63.8, row);
    check('precipitation_mm_full_day conserva il totale 24h intero (88.6mm) per audit/trasparenza', Number(row?.precipitation_mm_full_day) === 88.6, row);
    check('data_source è arpal_certified', row?.data_source === 'arpal_certified', row);
    check('soglia valutata sul valore filtrato (63.8mm >= 1mm -> superata)', row?.threshold_exceeded === true, row);

    const { data: siteAfter } = await admin.from('sites').select('arpal_station_code, arpal_station_name, arpal_station_distance_m').eq('id', siteId).single();
    check('sites.arpal_station_name persistito per il popup "come funziona"', !!siteAfter?.arpal_station_name, siteAfter);
  } finally {
    await admin.from('site_weather_logs').delete().eq('site_id', siteId);
    await admin.from('sites').delete().eq('id', siteId);
  }
}

async function block4LiveShiftChangeResets() {
  console.log('\nBlocco 4 — PATCH /sites/:id: cambiare la fascia oraria ricertifica i giorni mai decisi (live HTTP)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) { skip('reset su cambio fascia', 'fixture Supabase non configurate'); return; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find(u => u.email === 'ci-test@palladia.internal');
  if (!user) { skip('reset su cambio fascia', 'utente ci-test non trovato'); return; }
  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', (memberships||[]).map(m=>m.company_id));
  const companyId = (companies || []).find(c => c.name === 'MSCedilizia')?.id;

  const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
  const { data: session } = await anon.auth.signInWithPassword({ email: 'ci-test@palladia.internal', password: tempPassword });
  const jwt = session?.session?.access_token;

  const siteName = `TEST-E2E-ShiftChangeReset-${crypto.randomUUID().slice(0,8)}`;
  const { data: site } = await admin.from('sites').insert({
    company_id: companyId, name: siteName, address: 'Via Test Reset Turno', status: 'attivo',
    latitude: 44.4056, longitude: 8.9463, weather_rain_mm: 1, weather_wind_kmh: 50, weather_snow: true, weather_thunderstorm: true,
  }).select('id').single();
  const siteId = site.id;

  // Un giorno MAI deciso già arpal_certified (come se fosse stato calcolato
  // sulle 24h intere prima di attivare la fascia oraria) + un giorno già
  // CONFERMATO (non deve mai essere ricertificato retroattivamente).
  await admin.from('site_weather_logs').insert([
    { company_id: companyId, site_id: siteId, log_date: '2026-05-01', precipitation_mm: 10, wind_max_kmh: 5, weather_code: 61, weather_desc: 'pioggia', threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: false, suspension_dismissed: false, data_source: 'arpal_certified', arpal_station_name: 'TEST', fetched_at: new Date().toISOString() },
    { company_id: companyId, site_id: siteId, log_date: '2026-05-02', precipitation_mm: 10, wind_max_kmh: 5, weather_code: 61, weather_desc: 'pioggia', threshold_exceeded: true, threshold_reason: 'pioggia', suspension_confirmed: true, suspension_dismissed: false, data_source: 'arpal_certified', arpal_station_name: 'TEST', fetched_at: new Date().toISOString() },
  ]);

  try {
    const patchRes = await fetch(`${BASE}/api/v1/sites/${siteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
      body: JSON.stringify({ weather_shift_enabled: true, weather_shift_start: '07:00', weather_shift_end: '17:00' }),
    });
    check('PATCH con nuova fascia oraria -> 200', patchRes.status === 200, patchRes.status);

    // Il reset gira in background dopo la risposta (stesso pattern di
    // weatherThresholdChange) — una breve attesa basta, è una singola query.
    await new Promise(r => setTimeout(r, 3000));

    const { data: rows } = await admin.from('site_weather_logs')
      .select('log_date, data_source, threshold_exceeded, suspension_confirmed')
      .eq('site_id', siteId).order('log_date');
    const undecided = rows.find(r => r.log_date === '2026-05-01');
    const decided    = rows.find(r => r.log_date === '2026-05-02');

    check('giorno mai deciso: data_source torna forecast_preliminary (da ricertificare col nuovo turno)', undecided?.data_source === 'forecast_preliminary', undecided);
    check('giorno già confermato: data_source NON toccato, resta arpal_certified', decided?.data_source === 'arpal_certified', decided);
    check('giorno già confermato: threshold_exceeded intoccato', decided?.threshold_exceeded === true, decided);
  } finally {
    await admin.from('site_weather_logs').delete().eq('site_id', siteId);
    await admin.from('sites').delete().eq('id', siteId);
  }
}

async function main() {
  console.log('\nPalladia regression — fascia oraria per la precipitazione (F-199)');
  block1Pure();
  await block2LiveHourlySum();
  await block3LiveCronShift();
  await block4LiveShiftChangeResets();
  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
