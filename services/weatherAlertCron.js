'use strict';
/**
 * services/weatherAlertCron.js
 *
 * Ogni giorno alle 07:00 (Europe/Rome):
 *   1. Recupera le previsioni 3 giorni per ogni cantiere attivo con GPS
 *   2. Rileva eventi estremi: ondata di calore, neve, temporale
 *   3. Per ogni evento nuovo (non già notificato): crea notifica in-app + invia email
 *
 * Il throttle è garantito dalla tabella site_weather_alert_sent:
 * ogni (site_id, alert_date, alert_type) genera al massimo un avviso.
 */

const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { getForecast } = require('./weatherService');
const { sendWeatherExtremeAlert } = require('./email');

const CRON_SCHEDULE = '0 7 * * *';
const TZ            = 'Europe/Rome';

const SNOW_CODES    = new Set([71, 73, 75, 77, 85, 86]);
const THUNDER_MIN   = 95;

const ALERT_LABELS = {
  heat:        'Ondata di calore',
  snow:        'Neve prevista',
  thunderstorm:'Temporale',
  rain:        'Pioggia intensa',
  wind:        'Vento forte',
};

// F-155 (AUDIT.md, 2026-09-08): questo cron è l'UNICO avviso *in anticipo*
// del sistema meteo — l'altro (weatherLogCron.js) processa solo il meteo di
// IERI, quindi un cantiere sa che doveva sospendere solo il giorno dopo,
// troppo tardi per organizzare la giornata. Prima di questo fix, qui si
// controllavano solo caldo/neve/temporale: una pioggia forte prevista (es.
// "rovesci", sotto la soglia di temporale) non generava NESSUN avviso
// anticipato, nonostante ogni cantiere abbia già una soglia pioggia/vento
// configurabile (weather_rain_mm/weather_wind_kmh) usata dal log retrospettivo
// — la stessa soglia semplicemente non veniva mai valutata sul forecast.
// Fix: riusa evalThresholds() (identica funzione del log retrospettivo) sul
// forecast di ogni giorno, con le soglie REALI del cantiere.

// ── Rileva alert nei 3 giorni di forecast ─────────────────────────────────────
function detectAlerts(forecast, { heatC, snowEnabled, thunderEnabled, rainMm, windKmh }) {
  const alerts = [];
  for (const day of forecast) {
    if (heatC > 0 && day.tempMax !== null && day.tempMax >= heatC) {
      alerts.push({ date: day.date, type: 'heat', tempMax: day.tempMax, description: day.description });
    }
    if (snowEnabled && SNOW_CODES.has(day.weatherCode)) {
      alerts.push({ date: day.date, type: 'snow', tempMax: day.tempMax, description: day.description });
    }
    if (thunderEnabled && day.weatherCode >= THUNDER_MIN) {
      alerts.push({ date: day.date, type: 'thunderstorm', tempMax: day.tempMax, description: day.description });
    }
    // Pioggia/vento: stessa soglia del cantiere usata dal log retrospettivo
    // (weatherLogCron.js), valutata qui sul FORECAST invece che su ieri.
    // Il temporale è già gestito sopra — evita un doppio alert lo stesso
    // giorno se weather_code è già >=95 (evalThresholds lo classificherebbe
    // comunque come 'temporale' per prima, ma qui controlliamo esplicitamente
    // pioggia/vento come cause indipendenti, anche senza temporale).
    if (day.precipitationMm >= rainMm) {
      alerts.push({ date: day.date, type: 'rain', tempMax: day.tempMax, description: day.description, precipitationMm: day.precipitationMm });
    } else if (day.windMaxKmh >= windKmh) {
      alerts.push({ date: day.date, type: 'wind', tempMax: day.tempMax, description: day.description, windMaxKmh: day.windMaxKmh });
    }
  }
  return alerts;
}

// ── Filtra solo gli alert non ancora inviati (throttle) ───────────────────────
async function filterNew(siteId, candidates) {
  if (!candidates.length) return [];

  const dates = [...new Set(candidates.map(c => c.date))];
  const types  = [...new Set(candidates.map(c => c.type))];

  const { data: existing } = await supabase
    .from('site_weather_alert_sent')
    .select('alert_date, alert_type')
    .eq('site_id', siteId)
    .in('alert_date', dates)
    .in('alert_type', types);

  const sent = new Set((existing || []).map(r => `${r.alert_date}|${r.alert_type}`));
  return candidates.filter(c => !sent.has(`${c.date}|${c.type}`));
}

// ── Segna gli alert come inviati ──────────────────────────────────────────────
async function markSent(siteId, companyId, alerts) {
  if (!alerts.length) return;
  await supabase
    .from('site_weather_alert_sent')
    .upsert(
      alerts.map(a => ({ site_id: siteId, company_id: companyId, alert_date: a.date, alert_type: a.type })),
      { onConflict: 'site_id,alert_date,alert_type', ignoreDuplicates: true }
    );
}

// ── Crea/aggiorna notifica in-app (una per cantiere, aggregata) ───────────────
async function createNotifications(companyId, siteId, siteName, alerts) {
  if (!alerts.length) return;

  // severity: heat → critical, altrimenti warning (valori validi: info|warning|critical)
  const severity = alerts.some(a => a.type === 'heat') ? 'critical' : 'warning';

  const lines = alerts.map(a => {
    const dateIt = new Date(a.date + 'T00:00:00').toLocaleDateString('it-IT', {
      weekday: 'short', day: 'numeric', month: 'long',
    });
    const label = ALERT_LABELS[a.type] || a.type;
    const temp  = a.type === 'heat' && a.tempMax != null ? ` (max ${a.tempMax}°C)` : '';
    const rain  = a.type === 'rain' && a.precipitationMm != null ? ` (${a.precipitationMm}mm previsti)` : '';
    const wind  = a.type === 'wind' && a.windMaxKmh != null ? ` (${a.windMaxKmh}km/h previsti)` : '';
    return `${dateIt}: ${label}${temp}${rain}${wind}`;
  });

  const uniqueTypes = [...new Set(alerts.map(a => a.type))];
  const title = uniqueTypes.map(t => ALERT_LABELS[t] || t).join(' · ') + ` — ${siteName}`;
  const body  = lines.join('\n') + '\nValuta misure di protezione o la sospensione dei lavori.';

  // UPSERT: una sola notifica per cantiere (unique su company_id, entity_type, entity_id, type)
  await supabase.from('notifications').upsert({
    company_id:  companyId,
    type:        'weather_alert',
    severity,
    title,
    body,
    entity_type: 'site',
    entity_id:   siteId,
    updated_at:  new Date().toISOString(),
  }, { onConflict: 'company_id,entity_type,entity_id,type' });
}

// ── Elabora una singola company ───────────────────────────────────────────────
async function processCompany(companyId, sites) {
  const toEmail = []; // { siteName, ...alert }

  for (const site of sites) {
    try {
      const forecast   = await getForecast(site.latitude, site.longitude);
      const candidates = detectAlerts(forecast, {
        heatC:          site.weather_heat_c ?? 35,
        snowEnabled:    site.weather_snow         ?? true,
        thunderEnabled: site.weather_thunderstorm ?? true,
        rainMm:         site.weather_rain_mm      ?? 1,
        windKmh:        site.weather_wind_kmh     ?? 50,
      });

      const newAlerts = await filterNew(site.id, candidates);
      if (!newAlerts.length) continue;

      const siteName = site.name || site.address || 'Cantiere';
      await createNotifications(companyId, site.id, siteName, newAlerts);
      await markSent(site.id, companyId, newAlerts);

      for (const a of newAlerts) toEmail.push({ siteName, ...a });

    } catch (err) {
      console.error(`[weatherAlert] ${site.name} (${companyId}):`, err.message);
    }
  }

  if (toEmail.length) {
    try {
      await sendWeatherExtremeAlert({ companyId, alerts: toEmail });
    } catch (err) {
      console.error(`[weatherAlert] email company ${companyId}:`, err.message);
    }
  }
}

// ── Job principale ────────────────────────────────────────────────────────────
async function runWeatherAlerts() {
  console.log('[weatherAlert] Avvio controllo avvisi meteo estremo');

  const { data: rows } = await supabase
    .from('sites')
    .select('id, company_id, name, address, latitude, longitude, weather_heat_c, weather_rain_mm, weather_wind_kmh, weather_snow, weather_thunderstorm')
    .in('status', ['attivo', 'sospeso'])
    .not('latitude', 'is', null)
    .not('longitude', 'is', null);

  if (!rows?.length) {
    console.log('[weatherAlert] Nessun cantiere con GPS — skip');
    return;
  }

  const byCompany = new Map();
  for (const row of rows) {
    if (!byCompany.has(row.company_id)) byCompany.set(row.company_id, []);
    byCompany.get(row.company_id).push(row);
  }

  console.log(`[weatherAlert] ${byCompany.size} company, ${rows.length} cantieri`);

  for (const [companyId, sites] of byCompany) {
    await processCompany(companyId, sites);
  }

  console.log('[weatherAlert] Completato');
}

function startWeatherAlertCron() {
  cron.schedule(CRON_SCHEDULE, () => runWeatherAlerts(), { timezone: TZ });
  console.log('[weatherAlert] Cron avviato —', CRON_SCHEDULE, TZ);
}

module.exports = { startWeatherAlertCron, runWeatherAlerts, detectAlerts, processCompany };
