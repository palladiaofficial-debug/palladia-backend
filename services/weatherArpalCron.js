'use strict';
/**
 * services/weatherArpalCron.js
 *
 * F-199 (AUDIT.md): fetch AUTOMATICO della precipitazione certificata ARPAL
 * per ogni cantiere con GPS — decisione esplicita del titolare dopo aver
 * visto in produzione il flusso di upload manuale: "non devo caricare io i
 * dati Arpal, devono essere presi in automatico da open meteo ecc" (cioè con
 * lo stesso automatismo già in uso per Open-Meteo/ERA5).
 *
 * Ogni giorno alle 05:15 (Europe/Rome), tra weatherReconcileCron (05:00,
 * ERA5) e weatherLogCron (06:30, meteo di "ieri"):
 *   1. Per ogni cantiere con GPS, trova la stazione ARPAL più vicina con
 *      dati di precipitazione reali (non tutte le stazioni li misurano —
 *      arpalWeatherSource.js prova le 5 più vicine in ordine).
 *   2. Richiede il range [più vecchio giorno NON arpal_certified, ieri] —
 *      una volta che un giorno diventa arpal_certified non viene più
 *      ritoccato (fonte con la massima precedenza, stessa logica del filtro
 *      data_source='forecast_preliminary' di weatherReconcileCron).
 *   3. Applica buildArpalWeatherLogUpdate riga per riga: un giorno già
 *      deciso da un umano (confermato/ignorato) non vede mai cambiare il
 *      verdetto, solo il dato grezzo + un flag di discrepanza (F-159).
 *
 * Un fallimento del portale ARPAL su un cantiere (rete, sito cambiato,
 * nessuna stazione con dati) non blocca gli altri cantieri né lascia il
 * cantiere senza dati — resta semplicemente la stima ERA5 già presente,
 * finché il prossimo giro non riesce. Mai un errore fatale per un cron
 * schedulato.
 */
const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { resolveArpalPrecipitation } = require('./arpalWeatherSource');
const { buildArpalWeatherLogUpdate } = require('./weatherService');
const { upsertWeatherNotification }  = require('./weatherLogCron');
const { sumShiftPrecipitation }      = require('../lib/weatherShift');

const CRON_SCHEDULE = '15 5 * * *'; // 05:15 ogni giorno — tra weatherReconcile (05:00) e weatherLog (06:30)
const TZ = 'Europe/Rome';

function yesterdayISO() {
  const d = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: TZ }));
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

const EXISTING_COLS = 'log_date, suspension_confirmed, suspension_dismissed, threshold_exceeded, ' +
  'precipitation_mm, wind_max_kmh, temp_min_c, temp_max_c, weather_code, weather_desc, data_source, ' +
  'era5_reconciled_at, precipitation_mm_original, wind_max_kmh_original, weather_code_original';

async function arpalizeSite(site, stationCache) {
  const { data: pending, error: pendingErr } = await supabase
    .from('site_weather_logs')
    .select(EXISTING_COLS)
    .eq('site_id', site.id)
    .neq('data_source', 'arpal_certified')
    .order('log_date', { ascending: true });

  if (pendingErr) throw new Error(pendingErr.message);
  if (!pending?.length) return { imported: 0, discrepancies: 0, newlyPendingDays: [], station: null };

  const minDate = pending[0].log_date;
  const maxDate = yesterdayISO();
  if (minDate > maxDate) return { imported: 0, discrepancies: 0, newlyPendingDays: [], station: null };

  // F-199 (AUDIT.md): "se lavoro di giorno non mi interessa se piove la
  // sera" — un cantiere con weather_shift_enabled fetcha i dati ORARI e
  // somma solo le ore dentro la fascia di turno configurata (fuso Europe/
  // Rome, gestito da lib/weatherShift.js), non il totale delle 24h.
  const useShift = !!site.weather_shift_enabled && !!site.weather_shift_start && !!site.weather_shift_end;
  const { stationName, stationCode, distance_m, rows: rawRows } =
    await resolveArpalPrecipitation(site.latitude, site.longitude, minDate, maxDate, stationCache, useShift ? 'HH' : 'GG');

  // Stazione risolta con successo: aggiorna sempre il riferimento sul
  // cantiere, anche se poi non ci sono righe da certificare in questo giro
  // — serve al popup "come funziona" per mostrare la fonte SUBITO, non solo
  // dopo il primo giorno certificato.
  await supabase.from('sites').update({
    arpal_station_code: stationCode, arpal_station_name: stationName,
    arpal_station_distance_m: distance_m, arpal_last_checked_at: new Date().toISOString(),
  }).eq('id', site.id);

  const arpalRows = useShift
    ? [...sumShiftPrecipitation(rawRows, site.weather_shift_start, site.weather_shift_end)]
        .map(([date, b]) => ({ date, precipitation_mm: b.shiftMm, precipitation_mm_full_day: b.fullDayMm, valid: !b.hasInvalid }))
    : rawRows;

  const existingByDate = new Map(pending.map(r => [r.log_date, r]));
  const thresholds = {
    rain_mm: site.weather_rain_mm, wind_kmh: site.weather_wind_kmh,
    snow: site.weather_snow, thunderstorm: site.weather_thunderstorm,
  };

  const updates = [];
  for (const r of arpalRows) {
    if (!r.valid || r.precipitation_mm === null) continue;
    const existing = existingByDate.get(r.date);
    if (!existing) continue; // fuori dal range di righe non ancora certificate per questo sito
    const update = buildArpalWeatherLogUpdate(existing, r, stationName, thresholds);
    if (useShift) update.precipitation_mm_full_day = r.precipitation_mm_full_day;
    updates.push({ company_id: site.company_id, site_id: site.id, log_date: r.date, ...update });
  }
  if (!updates.length) return { imported: 0, discrepancies: 0, newlyPendingDays: [], station: { name: stationName, distance_m } };

  const decidedRows   = updates.filter(r => !('threshold_exceeded' in r));
  const undecidedRows = updates.filter(r => 'threshold_exceeded' in r);
  for (const batch of [undecidedRows, decidedRows]) {
    if (!batch.length) continue;
    const { error } = await supabase.from('site_weather_logs').upsert(batch, { onConflict: 'site_id,log_date' });
    if (error) throw new Error(error.message);
  }

  const newlyPendingDays = updates
    .filter(r => 'threshold_exceeded' in r && r.threshold_exceeded)
    .filter(r => !existingByDate.get(r.log_date)?.threshold_exceeded)
    .map(r => r.log_date);

  return {
    imported: updates.length,
    discrepancies: updates.filter(r => r.era5_discrepancy).length,
    newlyPendingDays,
    station: { name: stationName, code: stationCode, distance_m },
  };
}

async function runWeatherArpalCron() {
  console.log('[weatherArpal] Avvio fetch automatico ARPAL');

  const { data: sites, error } = await supabase
    .from('sites')
    .select('id, company_id, name, latitude, longitude, weather_rain_mm, weather_wind_kmh, weather_snow, weather_thunderstorm, weather_shift_enabled, weather_shift_start, weather_shift_end')
    .not('latitude', 'is', null)
    .not('longitude', 'is', null);

  if (error) { console.error('[weatherArpal] errore caricamento cantieri:', error.message); return; }
  if (!sites?.length) { console.log('[weatherArpal] nessun cantiere con GPS'); return; }

  // Condivisa tra tutti i cantieri di questo giro: una stazione senza dati
  // di precipitazione non va ritentata per ogni cantiere che la trova come
  // più vicina.
  const stationCache = new Map();
  let totalImported = 0, totalDiscrepancies = 0, totalNewAlerts = 0, sitesUpdated = 0, sitesFailed = 0;

  for (const site of sites) {
    try {
      const r = await arpalizeSite(site, stationCache);
      if (r.imported > 0) {
        sitesUpdated++;
        totalImported += r.imported;
        totalDiscrepancies += r.discrepancies;
        console.log(`[weatherArpal] ${site.name}: ${r.imported} giorni da ${r.station.name} (${r.station.distance_m}m)`);

        if (r.newlyPendingDays.length) {
          totalNewAlerts += r.newlyPendingDays.length;
          const { data: pendingRows } = await supabase
            .from('site_weather_logs')
            .select('log_date')
            .eq('site_id', site.id)
            .eq('threshold_exceeded', true)
            .eq('suspension_confirmed', false)
            .eq('suspension_dismissed', false);
          await upsertWeatherNotification(site.company_id, site.id, site.name || 'Cantiere', (pendingRows || []).map(p => p.log_date));
        }
      }
    } catch (err) {
      sitesFailed++;
      // Mai fatale: il cantiere resta con la stima ERA5 esistente, si
      // ritenta al prossimo giro (rete instabile, portale cambiato, nessuna
      // stazione vicina con dati).
      console.error(`[weatherArpal] ${site.name}: ${err.message}`);
    }
  }

  console.log(`[weatherArpal] Completato: ${sitesUpdated} cantieri aggiornati (${totalImported} giorni, ${totalDiscrepancies} discrepanze su giorni già decisi, ${totalNewAlerts} nuovi giorni da confermare), ${sitesFailed} cantieri falliti`);
}

function startWeatherArpalCron() {
  cron.schedule(CRON_SCHEDULE, () => runWeatherArpalCron(), { timezone: TZ });
  console.log('[weatherArpal] Cron avviato —', CRON_SCHEDULE, TZ);
}

module.exports = { startWeatherArpalCron, runWeatherArpalCron };
