#!/usr/bin/env node
/**
 * scripts/selftest_weather_alert_rain_wind.js
 *
 * Regressione per F-155 (AUDIT.md, 2026-09-08): weatherAlertCron.js è
 * l'UNICO avviso *in anticipo* del sistema meteo — weatherLogCron.js
 * processa solo il meteo di IERI (alle 06:30 del giorno dopo, troppo tardi
 * per organizzare la giornata). Prima di questo fix, il forecast veniva
 * controllato solo per caldo/neve/temporale: una pioggia forte prevista
 * (es. "rovesci leggeri", code 80, sotto la soglia di temporale/95) non
 * generava NESSUN avviso anticipato, anche se ogni cantiere ha già una
 * soglia pioggia/vento configurabile (weather_rain_mm/weather_wind_kmh)
 * — quella soglia semplicemente non veniva mai valutata sul forecast.
 *
 * Scoperto verificando dal vivo il forecast reale dei cantieri di
 * MSCedilizia S.r.l.: pioggia all'88% di probabilità prevista, zero avviso
 * generato dal codice pre-fix.
 *
 * Test puro (nessuna rete/DB): chiama detectAlerts() con un forecast
 * fittizio che riproduce esattamente lo scenario reale trovato.
 */
'use strict';
require('dotenv').config();
const { detectAlerts } = require('../services/weatherAlertCron');

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got)}`); failed++; }
function check(name, cond, got) { cond ? ok(name) : fail(name, got); }

console.log('\nPalladia regression — avviso anticipato pioggia/vento nel forecast (F-155)\n');

// ── Caso reale: pioggia prevista (code 80, "rovesci leggeri"), sotto soglia temporale ──
{
  const forecast = [
    { date: '2026-09-08', weatherCode: 3,  description: 'coperto',         tempMax: 28, precipitationMm: 0,  windMaxKmh: 15 },
    { date: '2026-09-09', weatherCode: 80, description: 'rovesci leggeri', tempMax: 26, precipitationMm: 14, windMaxKmh: 20 }, // supera 10mm default
    { date: '2026-09-10', weatherCode: 95, description: 'temporale',       tempMax: 25, precipitationMm: 5,  windMaxKmh: 25 },
  ];
  const alerts = detectAlerts(forecast, { heatC: 35, snowEnabled: true, thunderEnabled: true, rainMm: 10, windKmh: 50 });

  const rainAlert = alerts.find(a => a.date === '2026-09-09' && a.type === 'rain');
  check('pioggia prevista sopra soglia (14mm >= 10mm) genera un alert "rain" — PRIMA di questo fix: zero alert', !!rainAlert, alerts);
  check('il dettaglio mm previsti è incluso nell\'alert', rainAlert?.precipitationMm === 14, rainAlert);

  const thunderAlert = alerts.find(a => a.date === '2026-09-10' && a.type === 'thunderstorm');
  check('il temporale (giorno separato) resta rilevato come prima', !!thunderAlert, alerts);

  const noAlertDay1 = !alerts.some(a => a.date === '2026-09-08');
  check('giorno sereno/coperto sotto soglia → nessun alert', noAlertDay1, alerts);
}

// ── Vento sopra soglia (senza pioggia) ─────────────────────────────────────
{
  const forecast = [
    { date: '2026-09-09', weatherCode: 1, description: 'prevalentemente sereno', tempMax: 24, precipitationMm: 2, windMaxKmh: 62 },
  ];
  const alerts = detectAlerts(forecast, { heatC: 35, snowEnabled: true, thunderEnabled: true, rainMm: 10, windKmh: 50 });
  const windAlert = alerts.find(a => a.type === 'wind');
  check('vento previsto sopra soglia (62km/h >= 50km/h) genera un alert "wind"', !!windAlert, alerts);
  check('il dettaglio km/h previsti è incluso nell\'alert', windAlert?.windMaxKmh === 62, windAlert);
}

// ── Soglia personalizzata del cantiere rispettata (non il default fisso) ──
{
  const forecast = [
    { date: '2026-09-09', weatherCode: 80, description: 'rovesci leggeri', tempMax: 24, precipitationMm: 6, windMaxKmh: 10 },
  ];
  // Soglia default (10mm) NON superata da 6mm — nessun alert
  const withDefault = detectAlerts(forecast, { heatC: 35, snowEnabled: true, thunderEnabled: true, rainMm: 10, windKmh: 50 });
  check('6mm sotto la soglia default (10mm) → nessun alert', withDefault.length === 0, withDefault);

  // Soglia personalizzata più bassa (5mm) — un cantiere più sensibile (es. lavori in quota) la supera
  const withCustom = detectAlerts(forecast, { heatC: 35, snowEnabled: true, thunderEnabled: true, rainMm: 5, windKmh: 50 });
  check('6mm sopra una soglia personalizzata del cantiere (5mm) → alert generato', withCustom.some(a => a.type === 'rain'), withCustom);
}

// ── Toggle neve/temporale del cantiere rispettati (prima erano hardcoded a true) ──
{
  const forecast = [
    { date: '2026-09-09', weatherCode: 95, description: 'temporale', tempMax: 22, precipitationMm: 3, windMaxKmh: 20 },
  ];
  const withThunderOff = detectAlerts(forecast, { heatC: 35, snowEnabled: true, thunderEnabled: false, rainMm: 10, windKmh: 50 });
  check('toggle "temporale" disattivato dal cantiere → nessun alert temporale (prima era sempre true)', !withThunderOff.some(a => a.type === 'thunderstorm'), withThunderOff);
}

console.log(`\n${passed} passati, ${failed} falliti\n`);
process.exitCode = failed > 0 ? 1 : 0;
