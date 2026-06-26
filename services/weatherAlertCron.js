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
};

// ── Rileva alert nei 3 giorni di forecast ─────────────────────────────────────
function detectAlerts(forecast, { heatC, snowEnabled, thunderEnabled }) {
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

// ── Crea notifiche in-app ─────────────────────────────────────────────────────
async function createNotifications(companyId, siteId, siteName, alerts) {
  const SEVERITY = { heat: 'danger', snow: 'warning', thunderstorm: 'warning' };

  for (const a of alerts) {
    const dateIt = new Date(a.date + 'T00:00:00').toLocaleDateString('it-IT', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    const label = ALERT_LABELS[a.type] || a.type;
    let title, body;

    if (a.type === 'heat') {
      title = `${label} — ${siteName}`;
      body  = `${dateIt}: temperatura massima prevista ${a.tempMax}°C. Adotta misure di protezione per i lavoratori (D.Lgs. 81/2008 art. 63).`;
    } else {
      title = `${label} prevista — ${siteName}`;
      body  = `${dateIt}: ${a.description}. Valuta la sospensione dei lavori e informa i lavoratori.`;
    }

    await supabase.from('notifications').insert({
      company_id:  companyId,
      type:        'weather_alert',
      severity:    SEVERITY[a.type] || 'warning',
      title,
      body,
      entity_type: 'site',
      entity_id:   siteId,
    });
  }
}

// ── Elabora una singola company ───────────────────────────────────────────────
async function processCompany(companyId, sites) {
  const toEmail = []; // { siteName, ...alert }

  for (const site of sites) {
    try {
      const forecast   = await getForecast(site.latitude, site.longitude);
      const candidates = detectAlerts(forecast, {
        heatC:         site.weather_heat_c ?? 35,
        snowEnabled:   site.weather_snow   !== false,
        thunderEnabled:site.weather_thunderstorm !== false,
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
    .select('id, company_id, name, address, latitude, longitude, weather_heat_c, weather_snow, weather_thunderstorm')
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

module.exports = { startWeatherAlertCron, runWeatherAlerts };
