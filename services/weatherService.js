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

module.exports = { getForecast, getWeatherSummary, isRainy, getActualWeather, evalThresholds, WMO };
