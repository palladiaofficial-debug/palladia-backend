#!/usr/bin/env node
/**
 * scripts/selftest_weather_era5_reconciliation.js
 *
 * Regressione per F-159 (AUDIT.md): weatherLogCron.js salva ogni giorno il
 * meteo di "ieri" chiamando SEMPRE la Forecast API (una stima) — mai
 * l'Archive/ERA5, che a 1 giorno di distanza non è ancora disponibile. Prima
 * di questo fix, quella stima non veniva MAI riverificata: l'etichetta
 * "confermato ERA5" mostrata dopo 10 giorni era calcolata solo sull'età
 * della data, mai su una vera riconciliazione — il numero salvato restava
 * la stima iniziale per sempre.
 *
 * Verificato dal vivo confrontando dati reali già in produzione con
 * l'Archive API richiamata ora sulle stesse date/coordinate:
 *   - un giorno stimato 3,4mm/vento 31km/h/codice 95 (temporale) → ERA5
 *     vero: 1,4mm/12km/h/codice 53 (pioggerella) — un temporale mai avvenuto.
 *   - un giorno stimato 0,2mm (nessuna soglia superata) → ERA5 vero: 2,6mm —
 *     un giorno di pioggia reale mai segnalato, mai corretto.
 *
 * Blocco 1 (puro, nessuna rete): buildWeatherLogUpdate() — la regola decisa
 * dall'utente (2026-09-09): un giorno già deciso da un umano (confermato o
 * ignorato) non vede MAI cambiare il verdetto, solo il dato grezzo, con
 * l'originale conservato e una discrepanza segnalata se il nuovo dato
 * avrebbe cambiato l'esito. Un giorno mai deciso viene aggiornato anche nel
 * verdetto.
 *
 * Blocco 2 (live, contro Supabase + Open-Meteo reali): semina un cantiere e
 * un log meteo vecchio con data_source='forecast_preliminary', esegue
 * davvero runWeatherReconcile() e verifica lo stato reale in DB dopo.
 */
'use strict';
require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { buildWeatherLogUpdate } = require('../services/weatherService');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

let passed = 0, failed = 0, skipped = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++;  }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }
function skip(name, why) { console.log(`  \x1b[33m–\x1b[0m ${name} (skip: ${why})`); skipped++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

const THRESHOLDS = { rain_mm: 10, wind_kmh: 50, snow: true, thunderstorm: true };

function block1Pure() {
  console.log('Blocco 1 — buildWeatherLogUpdate (puro, nessuna rete)\n');

  // Giorno MAI deciso, stima diceva "sotto soglia", ERA5 vero è sopra soglia.
  {
    const existing = { suspension_confirmed: false, suspension_dismissed: false, threshold_exceeded: false, precipitation_mm: 0.2, wind_max_kmh: 17, weather_code: 80, data_source: 'forecast_preliminary' };
    const era5 = { precipitation_mm: 14, wind_max_kmh: 17, weather_code: 80, temp_min: 10, temp_max: 20, weather_desc: 'rovesci leggeri', data_source: 'era5_confirmed' };
    const update = buildWeatherLogUpdate(existing, era5, THRESHOLDS);
    check('giorno mai deciso: il verdetto SI aggiorna col dato ERA5 (14mm >= 10mm soglia)', update.threshold_exceeded === true, update);
    check('giorno mai deciso: precipitation_mm aggiornato al valore ERA5', update.precipitation_mm === 14, update);
    check('giorno mai deciso: data_source diventa era5_confirmed', update.data_source === 'era5_confirmed', update);
    check('giorno mai deciso: originale conservato per audit', update.precipitation_mm_original === 0.2, update);
    check('giorno mai deciso: era5_reconciled_at valorizzato', !!update.era5_reconciled_at, update);
  }

  // Giorno GIÀ CONFERMATO sospeso, ERA5 vero smentisce (era un temporale stimato, ERA5 dice pioggerella sotto soglia).
  {
    const existing = { suspension_confirmed: true, suspension_dismissed: false, threshold_exceeded: true, precipitation_mm: 3.4, wind_max_kmh: 31.1, weather_code: 95, data_source: 'forecast_preliminary' };
    const era5 = { precipitation_mm: 1.4, wind_max_kmh: 12.2, weather_code: 53, temp_min: 15, temp_max: 24, weather_desc: 'pioggerella intensa', data_source: 'era5_confirmed' };
    const update = buildWeatherLogUpdate(existing, era5, THRESHOLDS);
    check('giorno già CONFERMATO: threshold_exceeded NON è nella risposta (verdetto intoccabile)', !('threshold_exceeded' in update), update);
    check('giorno già CONFERMATO: threshold_reason NON è nella risposta', !('threshold_reason' in update), update);
    check('giorno già CONFERMATO: era5_discrepancy = true (il nuovo dato avrebbe cambiato il verdetto)', update.era5_discrepancy === true, update);
    check('giorno già CONFERMATO: il dato grezzo si aggiorna comunque (precipitation_mm = 1.4)', update.precipitation_mm === 1.4, update);
    check('giorno già CONFERMATO: precipitation_mm_original conserva il 3.4 originale', update.precipitation_mm_original === 3.4, update);
    check('giorno già CONFERMATO: weather_code_original conserva il 95 originale', update.weather_code_original === 95, update);
  }

  // Giorno già IGNORATO (dismissed), ERA5 conferma lo stesso esito → nessuna discrepanza.
  {
    const existing = { suspension_confirmed: false, suspension_dismissed: true, threshold_exceeded: true, precipitation_mm: 12, wind_max_kmh: 20, weather_code: 61, data_source: 'forecast_preliminary' };
    const era5 = { precipitation_mm: 13, wind_max_kmh: 22, weather_code: 61, temp_min: 10, temp_max: 18, weather_desc: 'pioggia leggera', data_source: 'era5_confirmed' };
    const update = buildWeatherLogUpdate(existing, era5, THRESHOLDS);
    check('giorno già IGNORATO: threshold_exceeded resta fuori dalla risposta', !('threshold_exceeded' in update), update);
    check('giorno già IGNORATO: nessuna discrepanza se il verdetto ERA5 combacia (entrambi sopra soglia)', update.era5_discrepancy === false, update);
  }

  // Riconciliazione già avvenuta in passato: una seconda chiamata (es. un
  // ri-fetch manuale) non deve "ri-catturare" l'originale sovrascrivendolo
  // col valore ERA5 precedente (che diventerebbe l'originale sbagliato).
  {
    const existing = {
      suspension_confirmed: true, suspension_dismissed: false, threshold_exceeded: true,
      precipitation_mm: 1.4, wind_max_kmh: 12.2, weather_code: 53, data_source: 'era5_confirmed',
      era5_reconciled_at: '2026-09-01T05:00:00Z', precipitation_mm_original: 3.4, wind_max_kmh_original: 31.1, weather_code_original: 95,
    };
    const era5again = { precipitation_mm: 1.4, wind_max_kmh: 12.2, weather_code: 53, temp_min: 15, temp_max: 24, weather_desc: 'pioggerella intensa', data_source: 'era5_confirmed' };
    const update = buildWeatherLogUpdate(existing, era5again, THRESHOLDS);
    check('già riconciliato: un secondo giro NON sovrascrive l\'originale (resta 3.4, non 1.4)', update.precipitation_mm_original === 3.4, update);
    check('già riconciliato: era5_reconciled_at NON viene toccato di nuovo', update.era5_reconciled_at === '2026-09-01T05:00:00Z', update);
  }

  // Riga nuova (nessun existingRow) — comportamento base, deve funzionare come un insert normale.
  {
    const era5 = { precipitation_mm: 0, wind_max_kmh: 10, weather_code: 0, temp_min: 15, temp_max: 25, weather_desc: 'sereno', data_source: 'forecast_preliminary' };
    const update = buildWeatherLogUpdate(null, era5, THRESHOLDS);
    check('riga nuova: threshold_exceeded presente e corretto (false)', update.threshold_exceeded === false, update);
    check('riga nuova: nessun originale spurio (data_source è già forecast, non una riconciliazione)', update.precipitation_mm_original === null, update);
  }
}

async function block2Live() {
  console.log('\nBlocco 2 — riconciliazione live (Supabase + Open-Meteo reali)\n');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    skip('riconciliazione ERA5 live', 'fixture Supabase non configurate in questo ambiente');
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users?.users?.find(u => u.email === 'ci-test@palladia.internal');
  if (!user) { skip('riconciliazione ERA5 live', 'utente ci-test non trovato'); return; }

  const { data: memberships } = await admin.from('company_users').select('company_id').eq('user_id', user.id);
  const companyIds = (memberships || []).map(m => m.company_id);
  const { data: companies } = await admin.from('companies').select('id, name').in('id', companyIds);
  const company = (companies || []).find(c => c.name === 'MSCedilizia');
  check('Company di test MSCedilizia trovata', !!company, companies);
  const companyId = company?.id;

  const testSiteName = `TEST-E2E-WeatherReconcile-${crypto.randomUUID().slice(0, 8)}`;
  // Genova, coordinate reali — serve una posizione con dati ERA5 disponibili.
  const { data: site, error: siteErr } = await admin.from('sites').insert({
    company_id: companyId, name: testSiteName, address: 'Via Test Reconcile 1', status: 'attivo',
    latitude: 44.4056, longitude: 8.9463, start_date: '2026-08-01',
    weather_rain_mm: 10, weather_wind_kmh: 50, weather_snow: true, weather_thunderstorm: true,
  }).select('id').single();
  check('Cantiere di test creato', !siteErr && !!site, siteErr);
  const siteId = site?.id;

  // Data abbastanza vecchia da avere ERA5 disponibile ora (>10gg), ma nel
  // range coperto da Archive API (non richiede attesa).
  const oldDate = (() => { const d = new Date(); d.setDate(d.getDate() - 15); return d.toISOString().slice(0, 10); })();

  const { error: logErr } = await admin.from('site_weather_logs').insert({
    company_id: companyId, site_id: siteId, log_date: oldDate,
    // Valori volutamente sballati — servono solo a dimostrare che dopo la
    // riconciliazione il dato grezzo viene sovrascritto con quello vero.
    precipitation_mm: 999, wind_max_kmh: 999, weather_code: 95,
    temp_min_c: 0, temp_max_c: 0, weather_desc: 'FAKE-PRE-RECONCILE',
    threshold_exceeded: true, threshold_reason: 'temporale',
    suspension_confirmed: false, suspension_dismissed: false,
    data_source: 'forecast_preliminary', fetched_at: new Date().toISOString(),
  });
  check('Log meteo di test (fittizio, forecast_preliminary) seminato', !logErr, logErr);

  try {
    const { runWeatherReconcile } = require('../services/weatherReconcileCron');
    await runWeatherReconcile();

    const { data: after, error: afterErr } = await admin.from('site_weather_logs')
      .select('data_source, precipitation_mm, wind_max_kmh, weather_code, weather_desc, era5_reconciled_at, precipitation_mm_original')
      .eq('site_id', siteId).eq('log_date', oldDate).single();
    check('Query diretta DB dopo la riconciliazione', !afterErr, afterErr);
    check('data_source è passato a era5_confirmed', after?.data_source === 'era5_confirmed', after);
    check('precipitation_mm NON è più il valore fittizio 999 (sovrascritto col vero ERA5)', after?.precipitation_mm !== 999, after);
    check('weather_desc NON è più il placeholder fittizio', after?.weather_desc !== 'FAKE-PRE-RECONCILE', after);
    check('era5_reconciled_at valorizzato', !!after?.era5_reconciled_at, after);
    check('precipitation_mm_original conserva il valore fittizio pre-riconciliazione (999) per audit', after?.precipitation_mm_original === 999, after);
  } finally {
    await admin.from('site_weather_logs').delete().eq('site_id', siteId);
    await admin.from('sites').delete().eq('id', siteId);
  }
}

async function main() {
  console.log('\nPalladia regression — riconciliazione ERA5 dei log meteo (F-159)\n');
  block1Pure();
  await block2Live();
  console.log(`\n${passed} passati, ${failed} falliti, ${skipped} skippati\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => { console.error('ERRORE:', e.message, e); process.exitCode = 1; });
