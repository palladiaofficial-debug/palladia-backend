'use strict';
/**
 * services/weatherBackfill.js
 *
 * F-207 (AUDIT.md): logica di backfill storico meteo (ERA5, dall'inizio
 * cantiere a ieri) estratta da routes/v1/siteWeather.js perché va richiamata
 * da DUE punti, non uno solo:
 *   1. POST /sites/:siteId/weather-log/backfill (azione manuale, bottone
 *      "Carica storico" — comportamento invariato, stesso codice di prima).
 *   2. services/weatherLogCron.js (cron 06:30) — il pezzo NUOVO: se un
 *      cantiere ha una data di inizio nel passato ma nessuna riga meteo
 *      precedente alla più vecchia già salvata, il cron chiude il buco da
 *      solo, senza aspettare che qualcuno apra la scheda Meteo e clicchi.
 *
 * Il bug che questo modulo chiude: il frontend backfillava in automatico
 * SOLO al primo caricamento con `logs.length === 0` (SiteWeatherSection.tsx).
 * Ma il cron delle 06:30 scrive "il meteo di ieri" per OGNI cantiere con GPS,
 * ogni giorno, indipendentemente da chi apre l'app — quindi nella stragrande
 * maggioranza dei casi il cantiere ha già almeno una riga (quella di ieri)
 * la prima volta che un utente apre la scheda, la condizione `length === 0`
 * non è mai vera, e il buco fra `start_date` e la prima riga scritta dal
 * cron non viene mai colmato — né con la stima ERA5 né, di conseguenza, con
 * la certificazione ARPAL successiva (weatherArpalCron.js certifica solo
 * righe GIÀ esistenti, non ne crea di nuove). Osservato su MSCedilizia:
 * Via Riboli 4b (start_date 2025-09-18) aveva dati solo da 2026-05-23 in poi
 * — 8 mesi di storico mancanti, non 90 giorni per un limite del portale
 * ARPAL (verificato dal vivo: una singola richiesta ARPAL su un range di
 * 318 giorni torna tutte le righe, nessun troncamento).
 */
const supabase = require('../lib/supabase');
const { getWeatherRange, buildWeatherLogUpdate, groupRowsByShape, dataSourceRank } = require('./weatherService');

const TZ = 'Europe/Rome';

function yesterdayISO() {
  const d = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: TZ }));
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function siteThresholds(site) {
  return {
    rain_mm:      site.weather_rain_mm      ?? 1,
    wind_kmh:     site.weather_wind_kmh     ?? 50,
    snow:         site.weather_snow         ?? true,
    thunderstorm: site.weather_thunderstorm ?? true,
  };
}

/**
 * Scarica TUTTO lo storico meteo ERA5 dall'inizio cantiere (o da `fromDate`
 * se passato) a `toDate` (default: ieri) e lo salva in site_weather_logs.
 * Idempotente: upsert, non sovrascrive suspension_confirmed/dismissed né
 * un giorno già certificato da una fonte più autorevole (ARPAL — vedi
 * buildWeatherLogUpdate). Stesso identico comportamento del vecchio
 * endpoint HTTP, ora richiamabile anche dal cron.
 *
 * @param {{id, company_id, latitude, longitude, start_date, weather_rain_mm, weather_wind_kmh, weather_snow, weather_thunderstorm}} site
 * @param {{fromDate?: string, toDate?: string}} [opts]
 * @returns {Promise<{inserted:number, updated:number, unchanged:number, suspension_alerts:number}>}
 */
async function backfillSiteWeatherHistory(site, opts = {}) {
  if (!site.latitude || !site.longitude) {
    const err = new Error('Imposta le coordinate GPS del cantiere prima.');
    err.code = 'NO_COORDS';
    throw err;
  }
  if (!site.start_date) {
    const err = new Error('Il cantiere non ha una data di inizio lavori.');
    err.code = 'NO_START_DATE';
    throw err;
  }

  const fromDate = opts.fromDate || site.start_date;
  const toDate   = opts.toDate   || yesterdayISO();

  if (fromDate > toDate) return { inserted: 0, updated: 0, unchanged: 0, suspension_alerts: 0 };

  const weatherData = await getWeatherRange(site.latitude, site.longitude, fromDate, toDate);
  if (!weatherData.length) return { inserted: 0, updated: 0, unchanged: 0, suspension_alerts: 0 };

  // F-159 (AUDIT.md): un giorno già deciso da un umano (confermato/ignorato)
  // non deve vedersi cambiare il verdetto da un ri-backfill.
  const { data: existingRows } = await supabase
    .from('site_weather_logs')
    .select('log_date, suspension_confirmed, suspension_dismissed, threshold_exceeded, precipitation_mm, wind_max_kmh, weather_code, data_source, era5_reconciled_at, precipitation_mm_original, wind_max_kmh_original, weather_code_original')
    .eq('site_id', site.id)
    .gte('log_date', fromDate).lte('log_date', toDate);
  const existingByDate = new Map((existingRows || []).map(r => [r.log_date, r]));

  const thresholds = siteThresholds(site);
  const rows = weatherData.map(w => {
    const existing = existingByDate.get(w.date);
    return {
      company_id: site.company_id,
      site_id:    site.id,
      log_date:   w.date,
      // F-200 (AUDIT.md): marker interno, rimosso prima dell'upsert — vedi
      // groupRowsByShape.
      _blocked: !!existing && dataSourceRank(existing.data_source) > dataSourceRank(w.data_source),
      ...buildWeatherLogUpdate(existing, w, thresholds),
    };
  });

  const blockedCount = rows.filter(r => r._blocked).length;
  const dbRows = rows.map(({ _blocked, ...r }) => r);

  // F-200 (AUDIT.md): un upsert misto in un'unica chiamata scriverebbe NULL
  // sulle colonne mancanti per le righe con forma diversa (PostgREST usa
  // l'unione delle colonne del batch) — raggruppato per forma.
  for (const batch of groupRowsByShape(dbRows)) {
    const { error: upsertErr } = await supabase
      .from('site_weather_logs')
      .upsert(batch, { onConflict: 'site_id,log_date', ignoreDuplicates: false });
    if (upsertErr) throw new Error(upsertErr.message);
  }

  return {
    inserted:          rows.length,
    updated:           rows.length - blockedCount,
    unchanged:         blockedCount,
    suspension_alerts: rows.filter(r => r.threshold_exceeded).length,
  };
}

/**
 * True se il cantiere ha una data di inizio nel passato ma la riga più
 * vecchia già salvata è più recente — cioè esiste un buco fra l'inizio
 * cantiere e il primo giorno mai loggato (F-207). Include il caso "nessuna
 * riga ancora" (mai backfillato, mai passato il cron).
 */
async function hasWeatherHistoryGap(site) {
  if (!site.start_date) return false;
  const { data: earliest } = await supabase
    .from('site_weather_logs')
    .select('log_date')
    .eq('site_id', site.id)
    .order('log_date', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!earliest) return true;
  return earliest.log_date > site.start_date;
}

module.exports = { backfillSiteWeatherHistory, hasWeatherHistoryGap, yesterdayISO };
