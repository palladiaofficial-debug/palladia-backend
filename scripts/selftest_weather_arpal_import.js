#!/usr/bin/env node
/**
 * scripts/selftest_weather_arpal_import.js
 *
 * Regressione per F-199 (AUDIT.md): "i giorni di pioggia non funzionano" —
 * la fonte meteo era solo ERA5 (rianalisi su griglia, Open-Meteo), non il
 * dato che INPS riconosce per le richieste CIGO da maltempo in edilizia
 * (circolare n. 139 del 01/08/2016, verificata sul PDF ufficiale ARPAL).
 *
 * Formato CSV verificato scaricando dal vivo un'estrazione reale dal
 * portale ARPAL (https://ambientepub.regione.liguria.it/SiraQualMeteo/...,
 * stazione GENOVA - CENTRO FUNZIONALE) — non un formato immaginato.
 *
 * Blocco 1 (puro, nessuna rete): parseArpalCsv() e buildArpalWeatherLogUpdate()
 * — stessa regola di non-sovrascrittura di un giorno già deciso da un umano
 * di buildWeatherLogUpdate (F-159).
 *
 * Blocco 2 (live HTTP contro produzione): POST reale multipart del CSV
 * all'endpoint /weather-log/import-arpal su un cantiere di test seminato con
 * log ERA5 preesistenti — verifica che il DB rifletta davvero data_source
 * 'arpal_certified' e il valore di precipitazione certificato, non solo la
 * risposta HTTP.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { parseArpalCsv, buildArpalWeatherLogUpdate } = require('../services/weatherService');

const BASE = (process.env.TEST_BASE_URL || 'https://palladia-backend-production.up.railway.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

// Stesso formato del CSV reale scaricato dal portale ARPAL: ISO-8859-1, CRLF,
// date dd/mm/yyyy, decimale ".", una riga "Valido"="No" per verificare che
// venga scartata (nessun numero inventato su un dato legalmente rilevante).
const SAMPLE_CSV = [
  '',
  '"Stazione",GENOVA - CENTRO FUNZIONALE',
  '"Parametro",PRECIPITAZIONE - PRECIPITAZIONE CUMULATA (mm)',
  '',
  '"Inizio rilevazione","Fine rilevazione","Valore","Dataset","Valido"',
  '"01/03/2026","01/03/2026","0","Tutti i dati","S\xEC"',
  '"02/03/2026","02/03/2026","14.6","Tutti i dati","S\xEC"',
  '"03/03/2026","03/03/2026","56","Tutti i dati","S\xEC"',
  '"04/03/2026","04/03/2026","3","Tutti i dati","No"',
  '',
  '"Dati letti",4',
  '"Dati validi",3',
  '',
].join('\r\n');

function block1Pure() {
  console.log('\nBlocco 1 — parseArpalCsv / buildArpalWeatherLogUpdate (puro, nessuna rete)\n');

  const buf = Buffer.from(SAMPLE_CSV, 'latin1');
  const parsed = parseArpalCsv(buf);
  check('stazione riconosciuta dal CSV reale', parsed.stationName === 'GENOVA - CENTRO FUNZIONALE', parsed.stationName);
  check('4 righe totali parsate (incluso lo scarto)', parsed.rows.length === 4, parsed.rows.length);
  const d2 = parsed.rows.find(r => r.date === '2026-03-02');
  check('data dd/mm/yyyy convertita correttamente in ISO', !!d2, parsed.rows);
  check('decimale "." interpretato correttamente (14.6)', d2?.precipitation_mm === 14.6, d2);
  const d4 = parsed.rows.find(r => r.date === '2026-03-04');
  check('riga "Valido"="No" marcata non valida', d4?.valid === false, d4);
  const d1 = parsed.rows.find(r => r.date === '2026-03-01');
  check('riga "Sì" (accentata) marcata valida', d1?.valid === true, d1);

  // Parametro sbagliato → rifiuto esplicito, mai importato come pioggia per errore.
  const wrongParam = SAMPLE_CSV.replace('PRECIPITAZIONE - PRECIPITAZIONE CUMULATA (mm)', 'VENTO - Intensità Massima Del Vento');
  let threw = false;
  try { parseArpalCsv(Buffer.from(wrongParam, 'latin1')); } catch { threw = true; }
  check('CSV con parametro non-precipitazione viene rifiutato', threw);

  const THRESHOLDS = { rain_mm: 1, wind_kmh: 50, snow: true, thunderstorm: true };

  // Giorno mai deciso: ARPAL aggiorna precipitazione E verdetto, preserva vento/meteo esistenti.
  {
    const existing = { suspension_confirmed: false, suspension_dismissed: false, threshold_exceeded: false, precipitation_mm: 0, wind_max_kmh: 22, weather_code: 3, weather_desc: 'coperto', data_source: 'era5_confirmed' };
    const update = buildArpalWeatherLogUpdate(existing, { precipitation_mm: 56 }, 'GENOVA - CENTRO FUNZIONALE', THRESHOLDS);
    check('giorno mai deciso: precipitation_mm diventa il valore ARPAL (56)', update.precipitation_mm === 56, update);
    check('giorno mai deciso: wind_max_kmh preservato da ERA5 (22), non azzerato', update.wind_max_kmh === 22, update);
    check('giorno mai deciso: verdetto ricalcolato (56mm >= 1mm → superata)', update.threshold_exceeded === true, update);
    check('giorno mai deciso: data_source diventa arpal_certified', update.data_source === 'arpal_certified', update);
    check('giorno mai deciso: arpal_station_name valorizzato', update.arpal_station_name === 'GENOVA - CENTRO FUNZIONALE', update);
    check('giorno mai deciso: originale ERA5 conservato per audit', update.precipitation_mm_original === 0, update);
  }

  // Giorno già CONFERMATO da un umano: il verdetto non si tocca mai, solo il dato grezzo + discrepanza.
  {
    const existing = { suspension_confirmed: true, suspension_dismissed: false, threshold_exceeded: false, precipitation_mm: 0.3, wind_max_kmh: 10, weather_code: 51, weather_desc: 'pioggerella leggera', data_source: 'forecast_preliminary' };
    const update = buildArpalWeatherLogUpdate(existing, { precipitation_mm: 14.6 }, 'GENOVA - CENTRO FUNZIONALE', THRESHOLDS);
    check('giorno già confermato: threshold_exceeded NON è nella risposta (verdetto intoccabile)', !('threshold_exceeded' in update), update);
    check('giorno già confermato: il dato grezzo si aggiorna comunque (14.6)', update.precipitation_mm === 14.6, update);
    check('giorno già confermato: era5_discrepancy segnalata (il nuovo dato avrebbe cambiato il verdetto)', update.era5_discrepancy === true, update);
  }

  // Un secondo import non deve sovrascrivere l'originale già conservato.
  {
    const existing = { suspension_confirmed: false, suspension_dismissed: false, threshold_exceeded: true, precipitation_mm: 56, wind_max_kmh: 22, weather_code: 3, weather_desc: 'coperto', data_source: 'arpal_certified', precipitation_mm_original: 0, era5_reconciled_at: '2026-03-05T00:00:00.000Z' };
    const update = buildArpalWeatherLogUpdate(existing, { precipitation_mm: 56 }, 'GENOVA - CENTRO FUNZIONALE', THRESHOLDS);
    check('re-import dello stesso dato ARPAL: originale NON risovrascritto (resta 0)', update.precipitation_mm_original === 0, update);
  }
}

async function block2Live() {
  console.log('\nBlocco 2 — POST /weather-log/import-arpal (live HTTP contro produzione)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('import ARPAL live', 'fixture Supabase non configurate in questo ambiente');
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const anon  = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find(u => u.email === 'ci-test@palladia.internal');
  if (!user) { skip('import ARPAL live', 'utente ci-test non trovato'); return; }

  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', (memberships||[]).map(m=>m.company_id));
  const companyId = (companies || []).find(c => c.name === 'MSCedilizia')?.id;
  check('Company di test MSCedilizia trovata', !!companyId, companies);

  const tempPassword = 'CiTest' + Math.random().toString(36).slice(2, 10) + '!2';
  await admin.auth.admin.updateUserById(user.id, { password: tempPassword });
  const { data: session } = await anon.auth.signInWithPassword({ email: 'ci-test@palladia.internal', password: tempPassword });
  const jwt = session?.session?.access_token;
  check('sessione JWT ottenuta per ci-test', !!jwt);

  const siteName = `TEST-E2E-ArpalImport-${crypto.randomUUID().slice(0,8)}`;
  const { data: site } = await admin.from('sites').insert({
    company_id: companyId, name: siteName, address: 'Via Test ARPAL', status: 'attivo',
    latitude: 44.4056, longitude: 8.9463, weather_rain_mm: 1, weather_wind_kmh: 50, weather_snow: true, weather_thunderstorm: true,
  }).select('id').single();
  const siteId = site.id;

  // Un giorno MAI deciso (stima sbagliata, 0mm) + un giorno già CONFERMATO
  // (per verificare che l'import non ne alteri il verdetto).
  await admin.from('site_weather_logs').insert([
    { company_id: companyId, site_id: siteId, log_date: '2026-03-02', precipitation_mm: 0, wind_max_kmh: 15, weather_code: 2, weather_desc: 'parzialmente nuvoloso', threshold_exceeded: false, threshold_reason: null, suspension_confirmed: false, suspension_dismissed: false, data_source: 'era5_confirmed', fetched_at: new Date().toISOString() },
    { company_id: companyId, site_id: siteId, log_date: '2026-03-03', precipitation_mm: 0, wind_max_kmh: 15, weather_code: 2, weather_desc: 'parzialmente nuvoloso', threshold_exceeded: false, threshold_reason: null, suspension_confirmed: true, suspension_dismissed: false, data_source: 'era5_confirmed', fetched_at: new Date().toISOString() },
  ]);

  try {
    const csvBuffer = Buffer.from(SAMPLE_CSV, 'latin1');
    const boundary = '----PalladiaTestBoundary' + crypto.randomUUID().replace(/-/g, '');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="arpal_test.csv"\r\nContent-Type: text/csv\r\n\r\n`, 'utf8'),
      csvBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);

    const res = await fetch(`${BASE}/api/v1/sites/${siteId}/weather-log/import-arpal`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: `Bearer ${jwt}`, 'X-Company-Id': companyId },
      body,
    });
    const json = await res.json().catch(() => ({}));
    check('risposta HTTP 200', res.status === 200, { status: res.status, json });
    check('3 righe importate (la quarta, "Valido"=No, scartata)', json.imported === 3, json);
    check('1 riga scartata come non valida', json.skipped_invalid === 1, json);
    check('nome stazione riportato nella risposta', json.station_name === 'GENOVA - CENTRO FUNZIONALE', json);

    const { data: rows } = await admin.from('site_weather_logs')
      .select('log_date, precipitation_mm, wind_max_kmh, data_source, arpal_station_name, threshold_exceeded, era5_discrepancy, precipitation_mm_original')
      .eq('site_id', siteId).order('log_date');

    const undecided = rows.find(r => r.log_date === '2026-03-02');
    check('giorno mai deciso: data_source è davvero arpal_certified nel DB (non solo nella risposta)', undecided?.data_source === 'arpal_certified', undecided);
    check('giorno mai deciso: precipitation_mm nel DB è 14.6 (valore ARPAL reale)', Number(undecided?.precipitation_mm) === 14.6, undecided);
    check('giorno mai deciso: wind_max_kmh preservato da ERA5 (15)', Number(undecided?.wind_max_kmh) === 15, undecided);
    check('giorno mai deciso: threshold_exceeded ricalcolato true (14.6mm >= 1mm)', undecided?.threshold_exceeded === true, undecided);
    check('giorno mai deciso: arpal_station_name salvato nel DB', undecided?.arpal_station_name === 'GENOVA - CENTRO FUNZIONALE', undecided);

    const decided = rows.find(r => r.log_date === '2026-03-03');
    check('giorno già confermato: threshold_exceeded NEL DB resta false (verdetto intoccato)', decided?.threshold_exceeded === false, decided);
    check('giorno già confermato: precipitation_mm nel DB comunque aggiornato (56, dato grezzo)', Number(decided?.precipitation_mm) === 56, decided);
    check('giorno già confermato: era5_discrepancy segnalata nel DB', decided?.era5_discrepancy === true, decided);
  } finally {
    await admin.from('site_weather_logs').delete().eq('site_id', siteId);
    await admin.from('sites').delete().eq('id', siteId);
  }
}

async function main() {
  console.log('\nPalladia regression — import CSV ARPAL certificato per i giorni di pioggia (F-199)');
  block1Pure();
  await block2Live();
  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
