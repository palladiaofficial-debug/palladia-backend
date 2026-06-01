'use strict';
/**
 * services/weatherLogCron.js
 *
 * Ogni giorno alle 06:30 (Europe/Rome):
 *   1. Recupera il meteo REALE di ieri per ogni cantiere attivo con GPS
 *   2. Salva in site_weather_logs (upsert idempotente)
 *   3. Se soglia superata → crea/aggiorna notifica in-app
 *
 * Le notifiche invitano l'utente a confermare la sospensione.
 * Nessuna sospensione viene creata automaticamente.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { getActualWeather, evalThresholds } = require('./weatherService');

const CRON_SCHEDULE = '30 6 * * *'; // 06:30 ogni giorno
const TZ            = 'Europe/Rome';

// ── Utility: data di ieri in Rome time ────────────────────────────────────────
function yesterday() {
  const d = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: TZ }));
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0]; // 'YYYY-MM-DD'
}

// ── Salva/aggiorna notifica in-app per giorni meteo pendenti ─────────────────
async function upsertWeatherNotification(companyId, siteId, siteName, pendingDays) {
  if (pendingDays.length === 0) {
    // Rimuovi notifica se non ci sono più giorni pendenti
    await supabase
      .from('notifications')
      .delete()
      .eq('company_id', companyId)
      .eq('entity_type', 'site')
      .eq('entity_id', siteId)
      .eq('type', 'weather_suspension');
    return;
  }

  const sorted  = [...pendingDays].sort();
  const listIt  = sorted.map(d => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
  });

  const title = `Meteo — ${pendingDays.length} ${pendingDays.length === 1 ? 'giornata da confermare' : 'giornate da confermare'}`;
  const body  = `${siteName}\n${listIt.join(' · ')}\nVai al cantiere → Meteo per confermare o ignorare.`;

  await supabase
    .from('notifications')
    .upsert({
      company_id:  companyId,
      type:        'weather_suspension',
      severity:    'warning',
      title,
      body,
      entity_type: 'site',
      entity_id:   siteId,
      updated_at:  new Date().toISOString(),
    }, { onConflict: 'company_id,entity_type,entity_id,type' });
}

// ── Processo per singola company ──────────────────────────────────────────────
async function processCompany(companyId, dateISO) {
  // Cantieri attivi con GPS
  const { data: sites } = await supabase
    .from('sites')
    .select('id, name, address, latitude, longitude, weather_rain_mm, weather_wind_kmh, weather_snow, weather_thunderstorm')
    .eq('company_id', companyId)
    .in('status', ['attivo', 'sospeso'])
    .not('latitude', 'is', null)
    .not('longitude', 'is', null);

  if (!sites?.length) return;

  for (const site of sites) {
    try {
      const weather  = await getActualWeather(site.latitude, site.longitude, dateISO);
      const siteThresholds = {
        rain_mm:       site.weather_rain_mm,
        wind_kmh:      site.weather_wind_kmh,
        snow:          site.weather_snow,
        thunderstorm:  site.weather_thunderstorm,
      };
      const { exceeded, reason } = evalThresholds(weather, siteThresholds);

      // Upsert log meteo
      await supabase
        .from('site_weather_logs')
        .upsert({
          company_id:         companyId,
          site_id:            site.id,
          log_date:           dateISO,
          precipitation_mm:   weather.precipitation_mm,
          wind_max_kmh:       weather.wind_max_kmh,
          temp_min_c:         weather.temp_min,
          temp_max_c:         weather.temp_max,
          weather_code:       weather.weather_code,
          weather_desc:       weather.weather_desc,
          threshold_exceeded: exceeded,
          threshold_reason:   reason ?? null,
          fetched_at:         new Date().toISOString(),
        }, { onConflict: 'site_id,log_date' });

      // Aggiorna notifica: conta tutti i giorni pendenti del cantiere
      const { data: pending } = await supabase
        .from('site_weather_logs')
        .select('log_date')
        .eq('site_id', site.id)
        .eq('threshold_exceeded', true)
        .eq('suspension_confirmed', false)
        .eq('suspension_dismissed', false);

      const pendingDays = (pending || []).map(r => r.log_date);
      const siteName    = site.name || site.address || 'Cantiere';
      await upsertWeatherNotification(companyId, site.id, siteName, pendingDays);

    } catch (err) {
      console.error(`[weatherLog] ${site.name} (${dateISO}):`, err.message);
    }
  }
}

// ── Job principale ────────────────────────────────────────────────────────────
async function runWeatherLog(dateISO) {
  const date = dateISO || yesterday();
  console.log(`[weatherLog] Avvio elaborazione meteo per ${date}`);

  // Recupera tutte le company con almeno un cantiere attivo con GPS
  const { data: rows } = await supabase
    .from('sites')
    .select('company_id')
    .in('status', ['attivo', 'sospeso'])
    .not('latitude', 'is', null)
    .not('longitude', 'is', null);

  const companyIds = [...new Set((rows || []).map(r => r.company_id))];
  console.log(`[weatherLog] ${companyIds.length} company da elaborare`);

  // Elabora in sequenza per non sovraccaricare l'API meteo
  for (const cId of companyIds) {
    await processCompany(cId, date);
  }

  console.log(`[weatherLog] Completato per ${date}`);
}

// ── Export ────────────────────────────────────────────────────────────────────
function startWeatherLogCron() {
  cron.schedule(CRON_SCHEDULE, () => runWeatherLog(), { timezone: TZ });
  console.log('[weatherLog] Cron avviato —', CRON_SCHEDULE, TZ);
}

module.exports = { startWeatherLogCron, runWeatherLog };
