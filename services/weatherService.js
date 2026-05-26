'use strict';
/**
 * services/weatherService.js
 * Previsioni meteo via Open-Meteo API — gratuita, nessuna API key richiesta.
 * Documentazione: https://open-meteo.com/en/docs
 */

// WMO Weather Interpretation Codes → descrizione italiana
const WMO = {
  0: 'sereno',
  1: 'prevalentemente sereno', 2: 'parzialmente nuvoloso', 3: 'coperto',
  45: 'nebbia', 48: 'nebbia con brina',
  51: 'pioggerella leggera', 53: 'pioggerella', 55: 'pioggerella intensa',
  56: 'pioggerella gelata', 57: 'pioggerella gelata intensa',
  61: 'pioggia leggera', 63: 'pioggia moderata', 65: 'pioggia intensa',
  66: 'pioggia gelata', 67: 'pioggia gelata intensa',
  71: 'neve leggera', 73: 'neve moderata', 75: 'neve intensa', 77: 'granuli di neve',
  80: 'rovesci leggeri', 81: 'rovesci moderati', 82: 'rovesci violenti',
  85: 'rovesci di neve', 86: 'rovesci di neve intensi',
  95: 'temporale', 96: 'temporale con grandine', 99: 'temporale violento con grandine',
};

/** True se il codice WMO indica precipitazioni significative */
function isRainy(code) {
  return (code >= 51 && code <= 67) || (code >= 71 && code <= 77) ||
         (code >= 80 && code <= 86) || (code >= 95);
}

/**
 * Recupera forecast 3 giorni per una posizione GPS.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<Array<{date, precipProb, weatherCode, description, isRainy, tempMax, tempMin}>>}
 */
async function getForecast(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&daily=precipitation_probability_max,weathercode,temperature_2m_max,temperature_2m_min` +
    `&timezone=Europe%2FRome&forecast_days=3`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);

  const json = await res.json();
  const d = json.daily;

  return d.time.map((date, i) => ({
    date,
    precipProb:  d.precipitation_probability_max[i] ?? 0,
    weatherCode: d.weathercode[i] ?? 0,
    description: WMO[d.weathercode[i]] ?? 'variabile',
    isRainy:     isRainy(d.weathercode[i] ?? 0),
    tempMax:     d.temperature_2m_max[i]  ?? null,
    tempMin:     d.temperature_2m_min[i]  ?? null,
  }));
}

/**
 * Stringa meteo per il system prompt di Ladia (breve, 3 righe).
 * Restituisce null se il sito non ha coordinate o la chiamata fallisce.
 */
async function getWeatherSummary(lat, lon) {
  try {
    const forecast = await getForecast(lat, lon);
    const labels = ['Oggi', 'Domani', 'Dopodomani'];
    return forecast.map((f, i) => {
      const temp = f.tempMax !== null ? ` (${f.tempMin}–${f.tempMax}°C)` : '';
      const rain = f.precipProb > 20 ? ` — pioggia ${f.precipProb}%` : '';
      return `${labels[i]}: ${f.description}${temp}${rain}`;
    }).join('\n');
  } catch {
    return null;
  }
}

/**
 * Recupera dati meteo REALI per una data passata (o recente).
 * Usa Archive API per date > 7 giorni fa, Forecast API per i più recenti.
 * Restituisce { precipitation_mm, wind_max_kmh, temp_min, temp_max, weather_code, weather_desc }
 */
async function getActualWeather(lat, lon, dateISO) {
  const dayMs     = 86_400_000;
  const targetTs  = new Date(dateISO).getTime();
  const nowTs     = Date.now();
  const daysAgo   = Math.floor((nowTs - targetTs) / dayMs);

  // Open-Meteo Archive copre fino a ieri (con 1-2gg di latenza).
  // Forecast API copre i 2 mesi recenti con `start_date/end_date`.
  const base = daysAgo >= 10
    ? 'https://archive-api.open-meteo.com/v1/archive'
    : 'https://api.open-meteo.com/v1/forecast';

  const url =
    `${base}?latitude=${lat}&longitude=${lon}` +
    `&daily=precipitation_sum,wind_speed_10m_max,temperature_2m_max,temperature_2m_min,weather_code` +
    `&timezone=Europe%2FRome` +
    `&start_date=${dateISO}&end_date=${dateISO}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);

  const json = await res.json();
  const d    = json.daily;
  if (!d?.time?.length) throw new Error('Open-Meteo: risposta vuota');

  const code = d.weather_code?.[0] ?? 0;
  return {
    precipitation_mm: Number(d.precipitation_sum?.[0]   ?? 0),
    wind_max_kmh:     Number(d.wind_speed_10m_max?.[0]  ?? 0),
    temp_min:         d.temperature_2m_min?.[0] ?? null,
    temp_max:         d.temperature_2m_max?.[0] ?? null,
    weather_code:     code,
    weather_desc:     WMO[code] ?? 'variabile',
  };
}

/**
 * Recupera dati meteo REALI per un intero range di date in una singola chiamata API.
 * Usa archive API (ERA5) per range storici, poi forecast API per gli ultimi 10 giorni.
 * Restituisce un array ordinato per data: [{ date, precipitation_mm, wind_max_kmh, ... }]
 */
async function getWeatherRange(lat, lon, startDateISO, endDateISO) {
  const TZ = 'Europe/Rome';
  // Calcola ieri in ora italiana come limite massimo per archive
  const nowRome = new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
  const yest    = (() => { const d = new Date(nowRome); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]; })();
  const archiveEnd  = endDateISO  < yest ? endDateISO  : yest;
  const archiveStart = startDateISO;

  function parseRangeJson(json) {
    const d = json.daily;
    if (!d?.time?.length) return [];
    return d.time.map((date, i) => {
      const code = d.weather_code?.[i] ?? 0;
      return {
        date,
        precipitation_mm: Number(d.precipitation_sum?.[i]    ?? 0),
        wind_max_kmh:     Number(d.wind_speed_10m_max?.[i]   ?? 0),
        temp_min:         d.temperature_2m_min?.[i] ?? null,
        temp_max:         d.temperature_2m_max?.[i] ?? null,
        weather_code:     code,
        weather_desc:     WMO[code] ?? 'variabile',
      };
    });
  }

  const DAILY = 'precipitation_sum,wind_speed_10m_max,temperature_2m_max,temperature_2m_min,weather_code';
  const byDate = new Map();

  // Chiamata archive (ERA5) per tutto il range storico
  if (archiveStart <= archiveEnd) {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
      `&daily=${DAILY}&timezone=Europe%2FRome&start_date=${archiveStart}&end_date=${archiveEnd}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Open-Meteo Archive HTTP ${res.status}`);
    const json = await res.json();
    for (const r of parseRangeJson(json)) byDate.set(r.date, r);
  }

  // Chiamata forecast per gli ultimi giorni non coperti da archive (latenza ERA5 ~5gg)
  const tenDaysAgo = (() => { const d = new Date(nowRome); d.setDate(d.getDate() - 10); return d.toISOString().split('T')[0]; })();
  const forecastStart = startDateISO > tenDaysAgo ? startDateISO : tenDaysAgo;
  if (forecastStart <= endDateISO && forecastStart <= yest) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=${DAILY}&timezone=Europe%2FRome&start_date=${forecastStart}&end_date=${endDateISO < yest ? endDateISO : yest}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const json = await res.json();
      for (const r of parseRangeJson(json)) byDate.set(r.date, r); // forecast sovrascrive archive per date recenti
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Valuta se i dati meteo superano le soglie per suggerire sospensione.
 * Restituisce { exceeded, reason } oppure { exceeded: false }.
 */
function evalThresholds(data) {
  const { precipitation_mm, wind_max_kmh, weather_code } = data;
  if (weather_code >= 95)                                return { exceeded: true, reason: 'temporale' };
  if ([71,73,75,77,85,86].includes(weather_code))       return { exceeded: true, reason: 'neve' };
  if (precipitation_mm >= 10)                           return { exceeded: true, reason: 'pioggia' };
  if (wind_max_kmh >= 50)                               return { exceeded: true, reason: 'vento' };
  return { exceeded: false, reason: null };
}

module.exports = { getForecast, getWeatherSummary, isRainy, getActualWeather, getWeatherRange, evalThresholds, WMO };
