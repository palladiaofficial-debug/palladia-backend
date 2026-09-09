#!/usr/bin/env node
/**
 * scripts/selftest_weather_threshold_change_reeval.js
 *
 * Regressione per F-160 (AUDIT.md): cambiare la soglia pioggia di un
 * cantiere (es. per allinearla ai criteri INPS, msg. 28336/1998: 1mm per
 * impermeabilizzazione/coperture invece del vecchio default 10mm) non aveva
 * MAI alcun effetto sui log meteo già salvati — un giorno storico che ora
 * supera la nuova soglia restava "regolare" finché il cron di riconciliazione
 * non ripassava, giorni dopo. Verificato dal vivo su Ugo Bassi 28 (cantiere
 * reale, MSCedilizia S.r.l.): la soglia era già a 1mm ma con ~90 giorni mai
 * confermati/ignorati accumulati da mesi — esattamente il sintomo di questo
 * bug su una scala che ha reso la funzione inutilizzabile per l'utente.
 *
 * `reevaluateUndecidedWeatherLogs()` ricalcola il verdetto sui log MAI
 * decisi usando il dato grezzo già in DB (nessuna chiamata meteo) — un
 * giorno già confermato/ignorato non viene mai toccato (stessa regola di
 * buildWeatherLogUpdate, F-159).
 *
 * Blocco 1: chiamata diretta alla funzione su un cantiere di test seminato
 * con 3 giorni (mai deciso/sotto la nuova soglia, mai deciso/sopra la nuova
 * soglia, già deciso). Blocco 2: PATCH /sites/:id reale — verifica che
 * cambiare weather_rain_mm scateni da solo il ricalcolo, senza dover
 * aspettare il cron.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { reevaluateUndecidedWeatherLogs } = require('../services/weatherThresholdChange');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 300)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

async function main() {
  console.log('\nPalladia regression — ricalcolo log meteo storici al cambio soglia (F-160)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('ricalcolo soglia meteo', 'fixture Supabase non configurate in questo ambiente');
    console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
    process.exitCode = 0;
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find(u => u.email === 'ci-test@palladia.internal');
  if (!user) { skip('ricalcolo soglia meteo', 'utente ci-test non trovato'); console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`); return; }

  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', (memberships||[]).map(m=>m.company_id));
  const companyId = (companies || []).find(c => c.name === 'MSCedilizia')?.id;
  check('Company di test MSCedilizia trovata', !!companyId, companies);

  console.log('\nBlocco 1 — reevaluateUndecidedWeatherLogs() diretta\n');
  const siteName1 = `TEST-E2E-ThresholdReeval-${crypto.randomUUID().slice(0,8)}`;
  const { data: site1 } = await admin.from('sites').insert({
    company_id: companyId, name: siteName1, address: 'Via Test 1', status: 'attivo',
    latitude: 44.4056, longitude: 8.9463, weather_rain_mm: 10, weather_wind_kmh: 50, weather_snow: true, weather_thunderstorm: true,
  }).select('id').single();
  const siteId1 = site1.id;

  await admin.from('site_weather_logs').insert([
    { company_id: companyId, site_id: siteId1, log_date: '2026-01-01', precipitation_mm: 0.5, wind_max_kmh: 10, weather_code: 51, weather_desc: 'pioggerella', threshold_exceeded: false, threshold_reason: null, suspension_confirmed: false, suspension_dismissed: false, data_source: 'era5_confirmed', fetched_at: new Date().toISOString() },
    { company_id: companyId, site_id: siteId1, log_date: '2026-01-02', precipitation_mm: 5, wind_max_kmh: 10, weather_code: 61, weather_desc: 'pioggia leggera', threshold_exceeded: false, threshold_reason: null, suspension_confirmed: false, suspension_dismissed: false, data_source: 'era5_confirmed', fetched_at: new Date().toISOString() },
    { company_id: companyId, site_id: siteId1, log_date: '2026-01-03', precipitation_mm: 5, wind_max_kmh: 10, weather_code: 61, weather_desc: 'pioggia leggera', threshold_exceeded: false, threshold_reason: null, suspension_confirmed: false, suspension_dismissed: true, data_source: 'era5_confirmed', fetched_at: new Date().toISOString() },
  ]);

  try {
    const { changed } = await reevaluateUndecidedWeatherLogs(siteId1, companyId, siteName1, { rain_mm: 1, wind_kmh: 50, snow: true, thunderstorm: true });
    check('esattamente 1 riga cambiata (solo 01/02: 5mm supera la nuova soglia 1mm; 01/01 resta sotto, 01/03 già deciso e ignorato)', changed === 1, changed);

    const { data: rows } = await admin.from('site_weather_logs').select('log_date, threshold_exceeded, threshold_reason').eq('site_id', siteId1).order('log_date');
    const d1 = rows.find(r => r.log_date === '2026-01-01');
    const d2 = rows.find(r => r.log_date === '2026-01-02');
    const d3 = rows.find(r => r.log_date === '2026-01-03');
    check('01/01 (0.5mm < 1mm nuova soglia): resta non superata', d1.threshold_exceeded === false, d1);
    check('01/02 (5mm >= 1mm nuova soglia, mai deciso): ORA superata', d2.threshold_exceeded === true, d2);
    check('01/02: reason valorizzato', d2.threshold_reason === 'pioggia', d2);
    check('01/03 (5mm, già IGNORATO da un umano): verdetto intoccato, resta false', d3.threshold_exceeded === false, d3);

    const { data: notif } = await admin.from('notifications').select('title, body').eq('company_id', companyId).eq('entity_id', siteId1).eq('type', 'weather_suspension').maybeSingle();
    check('Notifica weather_suspension creata per il nuovo giorno pendente', !!notif, notif);
  } finally {
    await admin.from('notifications').delete().eq('entity_id', siteId1).eq('type', 'weather_suspension');
    await admin.from('site_weather_logs').delete().eq('site_id', siteId1);
    await admin.from('sites').delete().eq('id', siteId1);
  }

  console.log('\nBlocco 2 — PATCH /sites/:id scatena il ricalcolo da solo (live HTTP)\n');
  const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
  const { data: session } = await anon.auth.signInWithPassword({ email: 'ci-test@palladia.internal', password: tempPassword });
  const jwt = session?.session?.access_token;

  const siteName2 = `TEST-E2E-ThresholdReevalHTTP-${crypto.randomUUID().slice(0,8)}`;
  const { data: site2 } = await admin.from('sites').insert({
    company_id: companyId, name: siteName2, address: 'Via Test 2', status: 'attivo',
    latitude: 44.4056, longitude: 8.9463, weather_rain_mm: 10, weather_wind_kmh: 50, weather_snow: true, weather_thunderstorm: true,
  }).select('id').single();
  const siteId2 = site2.id;

  await admin.from('site_weather_logs').insert({
    company_id: companyId, site_id: siteId2, log_date: '2026-02-01', precipitation_mm: 5, wind_max_kmh: 10, weather_code: 61, weather_desc: 'pioggia leggera',
    threshold_exceeded: false, threshold_reason: null, suspension_confirmed: false, suspension_dismissed: false, data_source: 'era5_confirmed', fetched_at: new Date().toISOString(),
  });

  try {
    const patchRes = await fetch(`${BASE}/api/v1/sites/${siteId2}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
      body: JSON.stringify({ weather_rain_mm: 1 }),
    });
    check('PATCH weather_rain_mm → 200', patchRes.status === 200, await patchRes.clone().text());

    // reevaluateUndecidedWeatherLogs gira fuori dal path di risposta — piccola attesa per il giro async.
    await new Promise(r => setTimeout(r, 3000));

    const { data: row } = await admin.from('site_weather_logs').select('threshold_exceeded, threshold_reason').eq('site_id', siteId2).eq('log_date', '2026-02-01').single();
    check('Il log storico è stato ricalcolato SENZA aspettare il cron (5mm >= 1mm nuova soglia)', row.threshold_exceeded === true, row);
  } finally {
    await admin.from('notifications').delete().eq('entity_id', siteId2).eq('type', 'weather_suspension');
    await admin.from('site_weather_logs').delete().eq('site_id', siteId2);
    await admin.from('sites').delete().eq('id', siteId2);
  }

  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e); process.exitCode = 1; });
