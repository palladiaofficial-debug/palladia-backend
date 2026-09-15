'use strict';
/**
 * lib/arpalStations.js
 *
 * F-199 (AUDIT.md): elenco statico delle stazioni meteo ARPAL Liguria con
 * coordinate — costruito UNA VOLTA con scripts/_build_arpal_stations.js
 * (scarica dal portale ufficiale, ~274 stazioni, ~2 minuti) invece di
 * dipendere dal portale per la geocodifica ad ogni esecuzione del cron. Il
 * portale stesso serve solo il fetch dei dati giornalieri di precipitazione
 * per la stazione già identificata — vedi services/arpalWeatherSource.js.
 *
 * Il file va rigenerato a mano (non da un cron) se ARPAL aggiunge/rimuove
 * stazioni — evento raro, non vale la pena automatizzarlo.
 */
const stations = require('../data/arpal_stations.json');

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const MAX_STATION_DISTANCE_M = 30_000; // 30km — Liguria è stretta e allungata, la densità di stazioni è alta

/**
 * Trova la stazione ARPAL più vicina a una coordinata GPS.
 * @returns {{code: string, name: string, distance_m: number}|null} null se nessuna stazione entro MAX_STATION_DISTANCE_M
 */
function findNearestArpalStation(lat, lon) {
  return findNearestArpalStations(lat, lon, 1)[0] ?? null;
}

/**
 * Le N stazioni ARPAL più vicine, in ordine di distanza — non tutte le
 * stazioni misurano la precipitazione (es. GENOVA - UNIVERSITA' non ha un
 * pluviometro), quindi il chiamante (arpalWeatherSource.js) prova la lista
 * in ordine finché una risponde con dati reali.
 * @returns {Array<{code, name, distance_m}>} entro MAX_STATION_DISTANCE_M, può essere vuoto
 */
function findNearestArpalStations(lat, lon, limit = 5) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !stations.length) return [];
  return stations
    .map(s => ({ code: s.code, name: s.name, distance_m: Math.round(haversineM(lat, lon, s.lat, s.lon)) }))
    .filter(s => s.distance_m <= MAX_STATION_DISTANCE_M)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);
}

module.exports = { findNearestArpalStation, findNearestArpalStations, MAX_STATION_DISTANCE_M };
