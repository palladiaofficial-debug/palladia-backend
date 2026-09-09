'use strict';
/**
 * services/weatherThresholdChange.js
 *
 * F-160 (AUDIT.md): cambiare la soglia meteo di un cantiere (rain_mm/wind_kmh/
 * snow/thunderstorm) non aveva MAI alcun effetto retroattivo sui log già
 * salvati — solo le prossime letture del cron ne avrebbero tenuto conto. Un
 * utente che abbassava la soglia (es. per allinearla ai criteri INPS) non
 * vedeva comparire i giorni storici che ora la superano finché non passava
 * di nuovo il cron di riconciliazione, giorni dopo.
 *
 * Questa funzione ricalcola threshold_exceeded/reason sui log MAI decisi da
 * un umano (stessa regola di weatherService.js::buildWeatherLogUpdate — un
 * giorno già confermato/ignorato non viene mai toccato) usando il dato
 * grezzo già in DB, senza richiamare l'API meteo: è solo una nuova
 * valutazione della stessa soglia, non un nuovo dato.
 */

const supabase = require('../lib/supabase');
const { evalThresholds } = require('./weatherService');
const { upsertWeatherNotification } = require('./weatherLogCron');

async function reevaluateUndecidedWeatherLogs(siteId, companyId, siteName, thresholds) {
  const { data: rows, error } = await supabase
    .from('site_weather_logs')
    .select('id, precipitation_mm, wind_max_kmh, weather_code, threshold_exceeded')
    .eq('site_id', siteId)
    .eq('suspension_confirmed', false)
    .eq('suspension_dismissed', false);

  if (error) { console.error('[weatherThresholdChange]', siteId, error.message); return { changed: 0 }; }
  if (!rows?.length) return { changed: 0 };

  let changed = 0;
  for (const row of rows) {
    const { exceeded, reason } = evalThresholds(row, thresholds);
    if (exceeded === row.threshold_exceeded) continue;
    const { error: updErr } = await supabase
      .from('site_weather_logs')
      .update({ threshold_exceeded: exceeded, threshold_reason: reason ?? null })
      .eq('id', row.id);
    if (!updErr) changed++;
  }

  if (changed > 0) {
    const { data: pending } = await supabase
      .from('site_weather_logs')
      .select('log_date')
      .eq('site_id', siteId).eq('threshold_exceeded', true)
      .eq('suspension_confirmed', false).eq('suspension_dismissed', false);
    await upsertWeatherNotification(companyId, siteId, siteName, (pending || []).map(p => p.log_date));
  }

  return { changed };
}

module.exports = { reevaluateUndecidedWeatherLogs };
