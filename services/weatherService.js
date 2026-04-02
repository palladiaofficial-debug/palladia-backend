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

module.exports = { getForecast, getWeatherSummary, isRainy };
