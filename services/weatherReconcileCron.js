'use strict';
/**
 * services/weatherReconcileCron.js
 *
 * F-159 (AUDIT.md): weatherLogCron.js salva ogni giorno il meteo di "ieri"
 * chiamando SEMPRE la Forecast API di Open-Meteo (una stima) — mai
 * l'Archive/ERA5, perché a 1 giorno di distanza ERA5 non è ancora
 * disponibile (5-10gg di latenza). Prima di questo cron, quella stima non
 * veniva MAI riverificata: il frontend mostrava "confermato ERA5" dopo 10
 * giorni solo perché la data era vecchia, non perché il dato fosse stato
 * davvero controllato. Verificato dal vivo che questo produce sia falsi
 * allarmi (temporale mai avvenuto) sia giorni di pioggia reali mai
 * segnalati (0,2mm stimati contro 2,6mm ERA5 veri).
 *
 * Ogni giorno alle 05:00 (Europe/Rome), prima del log delle 06:30:
 *   1. Per ogni cantiere con GPS, trova i log con data_source='forecast_preliminary'
 *      più vecchi di RECONCILE_CUTOFF_DAYS (ERA5 dovrebbe essere disponibile).
 *   2. Richiama Open-Meteo Archive (ERA5) per l'intero range in una sola chiamata.
 *   3. Aggiorna il dato grezzo. Se il giorno non è mai stato deciso da un
 *      umano (né confermato né ignorato), aggiorna anche il verdetto
 *      threshold_exceeded — se questo lo fa diventare "da confermare",
 *      aggiorna la notifica in-app (lo stesso giorno può quindi comparire
 *      per la prima volta molti giorni dopo, se la stima iniziale lo aveva
 *      mancato).
 *   4. Se il giorno è già stato deciso (confermato o ignorato), il verdetto
 *      NON viene MAI toccato — decisione esplicita dell'utente, 2026-09-09:
 *      ha conseguenze reali già comunicate (operai, Cassa Edile, proroghe).
 *      Se il dato ERA5 avrebbe cambiato il verdetto, si segna solo
 *      era5_discrepancy=true per un'eventuale verifica manuale.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { getWeatherRange, buildWeatherLogUpdate } = require('./weatherService');
const { upsertWeatherNotification } = require('./weatherLogCron');

const CRON_SCHEDULE         = '0 5 * * *'; // 05:00 ogni giorno, prima del weatherLog delle 06:30
const TZ                    = 'Europe/Rome';
const RECONCILE_CUTOFF_DAYS = 10;

function cutoffDateISO() {
  const d = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: TZ }));
  d.setDate(d.getDate() - RECONCILE_CUTOFF_DAYS);
  return d.toISOString().split('T')[0];
}

const EXISTING_COLS = 'log_date, suspension_confirmed, suspension_dismissed, threshold_exceeded, ' +
  'precipitation_mm, wind_max_kmh, weather_code, data_source, era5_reconciled_at, ' +
  'precipitation_mm_original, wind_max_kmh_original, weather_code_original';

async function reconcileSite(site) {
  const { data: pending, error: pendingErr } = await supabase
    .from('site_weather_logs')
    .select(EXISTING_COLS)
    .eq('site_id', site.id)
    .eq('data_source', 'forecast_preliminary')
    .lt('log_date', cutoffDateISO())
    .order('log_date', { ascending: true });

  if (pendingErr) throw new Error(pendingErr.message);
  if (!pending?.length) return { reconciled: 0, discrepancies: 0, newlyPendingDays: [] };

  const minDate = pending[0].log_date;
  const maxDate = pending[pending.length - 1].log_date;
  const weatherData = await getWeatherRange(site.latitude, site.longitude, minDate, maxDate);
  const weatherByDate = new Map(weatherData.map(w => [w.date, w]));

  const thresholds = {
    rain_mm:      site.weather_rain_mm,
    wind_kmh:     site.weather_wind_kmh,
    snow:         site.weather_snow,
    thunderstorm: site.weather_thunderstorm,
  };

  let reconciled = 0, discrepancies = 0;
  const newlyPendingDays = [];

  for (const row of pending) {
    const w = weatherByDate.get(row.log_date);
    // Se ERA5 non ha ancora dati per questa data (edge case: latenza > 10gg
    // in un momento particolare), salta — verrà ritentata al prossimo giro.
    if (!w || w.data_source !== 'era5_confirmed') continue;

    const update = buildWeatherLogUpdate(row, w, thresholds);
    const { error } = await supabase
      .from('site_weather_logs')
      .update(update)
      .eq('site_id', site.id)
      .eq('log_date', row.log_date);
    if (error) { console.error(`[weatherReconcile] ${site.name} ${row.log_date}:`, error.message); continue; }

    reconciled++;
    if (update.era5_discrepancy) discrepancies++;

    const wasDecided = row.suspension_confirmed || row.suspension_dismissed;
    if (!wasDecided && update.threshold_exceeded && !row.threshold_exceeded) {
      newlyPendingDays.push(row.log_date);
    }
  }

  return { reconciled, discrepancies, newlyPendingDays };
}

async function runWeatherReconcile() {
  console.log('[weatherReconcile] Avvio riconciliazione ERA5');

  const { data: sites, error } = await supabase
    .from('sites')
    .select('id, company_id, name, latitude, longitude, weather_rain_mm, weather_wind_kmh, weather_snow, weather_thunderstorm')
    .not('latitude', 'is', null)
    .not('longitude', 'is', null);

  if (error) { console.error('[weatherReconcile] errore caricamento cantieri:', error.message); return; }
  if (!sites?.length) { console.log('[weatherReconcile] nessun cantiere con GPS'); return; }

  let totalReconciled = 0, totalDiscrepancies = 0, totalNewAlerts = 0;

  for (const site of sites) {
    try {
      const r = await reconcileSite(site);
      totalReconciled   += r.reconciled;
      totalDiscrepancies += r.discrepancies;

      if (r.newlyPendingDays.length) {
        totalNewAlerts += r.newlyPendingDays.length;
        const { data: pending } = await supabase
          .from('site_weather_logs')
          .select('log_date')
          .eq('site_id', site.id)
          .eq('threshold_exceeded', true)
          .eq('suspension_confirmed', false)
          .eq('suspension_dismissed', false);
        const pendingDays = (pending || []).map(p => p.log_date);
        const siteName = site.name || 'Cantiere';
        await upsertWeatherNotification(site.company_id, site.id, siteName, pendingDays);
      }
    } catch (err) {
      console.error(`[weatherReconcile] ${site.name}:`, err.message);
    }
  }

  console.log(`[weatherReconcile] Completato: ${totalReconciled} righe riconciliate con ERA5, ${totalDiscrepancies} discrepanze su giorni già decisi (verdetto NON alterato), ${totalNewAlerts} nuovi giorni scoperti da confermare`);
}

function startWeatherReconcileCron() {
  cron.schedule(CRON_SCHEDULE, () => runWeatherReconcile(), { timezone: TZ });
  console.log('[weatherReconcile] Cron avviato —', CRON_SCHEDULE, TZ);
}

module.exports = { startWeatherReconcileCron, runWeatherReconcile };
