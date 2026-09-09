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
    `&daily=precipitation_probability_max,precipitation_sum,wind_speed_10m_max,weathercode,temperature_2m_max,temperature_2m_min` +
    `&timezone=Europe%2FRome&forecast_days=3`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);

  const json = await res.json();
  const d = json.daily;

  return d.time.map((date, i) => ({
    date,
    precipProb:  d.precipitation_probability_max[i] ?? 0,
    // F-155 (AUDIT.md): precipitation_sum/wind_speed_10m_max in mm/km-h —
    // servono a valutare le soglie del cantiere (evalThresholds) SUL
    // FORECAST, non solo sul meteo passato — vedi weatherAlertCron.js.
    precipitationMm: d.precipitation_sum?.[i]  ?? 0,
    windMaxKmh:      d.wind_speed_10m_max?.[i] ?? 0,
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
    // F-159 (AUDIT.md): il chiamante deve sapere se questo è un dato ERA5
    // confermato o una stima Forecast API in attesa di riconciliazione —
    // prima non c'era modo di distinguerli dopo il salvataggio.
    data_source:      base.includes('archive-api') ? 'era5_confirmed' : 'forecast_preliminary',
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

  // F-159 (AUDIT.md): ogni riga porta la propria fonte — il chiamante (in
  // particolare weatherReconcileCron.js) deve sapere se un giorno è
  // ERA5 confermato o solo una stima Forecast API in attesa di conferma.
  function parseRangeJson(json, source) {
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
        data_source:      source,
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
    for (const r of parseRangeJson(json, 'era5_confirmed')) byDate.set(r.date, r);
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
      for (const r of parseRangeJson(json, 'forecast_preliminary')) byDate.set(r.date, r); // forecast sovrascrive archive per date recenti
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Valuta se i dati meteo superano le soglie per suggerire sospensione.
 * @param {object} data       - { precipitation_mm, wind_max_kmh, weather_code }
 * @param {object} thresholds - soglie custom del cantiere (opzionali, fallback ai default)
 * @returns {{ exceeded: boolean, reason: string|null }}
 */
function evalThresholds(data, thresholds = {}) {
  const { precipitation_mm, wind_max_kmh, weather_code } = data;
  const rainMm    = thresholds.rain_mm    != null ? Number(thresholds.rain_mm)    : 10;
  const windKmh   = thresholds.wind_kmh   != null ? Number(thresholds.wind_kmh)   : 50;
  const snowOn    = thresholds.snow       != null ? Boolean(thresholds.snow)       : true;
  const thunderOn = thresholds.thunderstorm != null ? Boolean(thresholds.thunderstorm) : true;

  if (thunderOn && weather_code >= 95)                        return { exceeded: true, reason: 'temporale' };
  if (snowOn && [71,73,75,77,85,86].includes(weather_code))  return { exceeded: true, reason: 'neve' };
  if (precipitation_mm >= rainMm)                             return { exceeded: true, reason: 'pioggia' };
  if (wind_max_kmh >= windKmh)                                return { exceeded: true, reason: 'vento' };
  return { exceeded: false, reason: null };
}

/**
 * F-159 (AUDIT.md): costruisce il payload di upsert per site_weather_logs a
 * partire da un dato meteo appena recuperato (fetch/backfill/riconciliazione)
 * e dalla riga esistente (se presente). Punto unico che applica la regola
 * decisa dall'utente: un giorno già deciso da un umano (suspension_confirmed
 * o suspension_dismissed) non vede MAI cambiare threshold_exceeded/reason da
 * un dato meteo più recente — ha conseguenze reali già comunicate (operai
 * mandati a casa, proroghe, Cassa Edile). Il dato grezzo si aggiorna comunque
 * per l'accuratezza storica/export; se il nuovo dato avrebbe cambiato il
 * verdetto, era5_discrepancy segnala la discrepanza senza applicarla.
 *
 * @param {object|null} existingRow - riga site_weather_logs già in DB, o null/undefined se nuova
 * @param {object} weather - risultato di getActualWeather/getWeatherRange (include data_source)
 * @param {object} thresholds - soglie del cantiere (siteThresholds)
 * @returns {object} campi da passare a .upsert()
 */
function buildWeatherLogUpdate(existingRow, weather, thresholds) {
  const { exceeded, reason } = evalThresholds(weather, thresholds);
  const isDecided = !!(existingRow?.suspension_confirmed || existingRow?.suspension_dismissed);
  const isNewlyConfirmed = weather.data_source === 'era5_confirmed' && existingRow?.data_source !== 'era5_confirmed';

  // Forma sempre uniforme (tranne threshold_exceeded/reason, omessi apposta
  // per i giorni decisi — vedi i chiamanti): un upsert bulk con chiavi
  // eterogenee tra le righe farebbe scrivere NULL/default sulle colonne
  // mancanti per alcune righe del batch (PostgREST usa l'unione delle
  // colonne). Meglio essere espliciti sempre, anche col valore di riposo.
  const update = {
    precipitation_mm: weather.precipitation_mm,
    wind_max_kmh:     weather.wind_max_kmh,
    temp_min_c:       weather.temp_min,
    temp_max_c:       weather.temp_max,
    weather_code:     weather.weather_code,
    weather_desc:     weather.weather_desc,
    data_source:      weather.data_source,
    fetched_at:       new Date().toISOString(),
    era5_discrepancy: isDecided && exceeded !== existingRow.threshold_exceeded,
    era5_reconciled_at:        isNewlyConfirmed ? new Date().toISOString() : (existingRow?.era5_reconciled_at ?? null),
    precipitation_mm_original: isNewlyConfirmed ? (existingRow?.precipitation_mm ?? null) : (existingRow?.precipitation_mm_original ?? null),
    wind_max_kmh_original:     isNewlyConfirmed ? (existingRow?.wind_max_kmh ?? null)     : (existingRow?.wind_max_kmh_original ?? null),
    weather_code_original:     isNewlyConfirmed ? (existingRow?.weather_code ?? null)     : (existingRow?.weather_code_original ?? null),
  };

  if (!isDecided) {
    update.threshold_exceeded = exceeded;
    update.threshold_reason   = reason ?? null;
  }

  return update;
}

module.exports = { getForecast, getWeatherSummary, isRainy, getActualWeather, getWeatherRange, evalThresholds, buildWeatherLogUpdate, WMO };
