'use strict';
/**
 * services/arpalWeatherSource.js
 *
 * F-199 (AUDIT.md): fetch AUTOMATICO della precipitazione certificata ARPAL
 * (stazione a terra — lo standard riconosciuto da INPS per le richieste CIGO,
 * circolare n. 139 del 01/08/2016) — decisione esplicita del titolare dopo
 * aver visto in produzione il flusso di upload manuale: "non devo caricare
 * io i dati Arpal, devono essere presi in automatico". L'upload manuale
 * (routes/v1/siteWeather.js, POST .../import-arpal) resta disponibile come
 * fallback/override, ma non è più il percorso primario.
 *
 * Il portale ARPAL (https://ambientepub.regione.liguria.it/SiraQualMeteo/...)
 * è un form ASP.NET del 2005 senza API REST pubblica — nessun JSON, sessione
 * a più passaggi con un ID generato server-side (IdRichiesta). Formato
 * verificato scaricando dal vivo un'estrazione reale (vedi
 * weatherService.js::parseArpalCsv, stesso parser riusato qui) prima di
 * scrivere questo scraper. L'URL è già cambiato una volta dal 2021 a oggi
 * (il link nel PDF ufficiale ARPAL non esiste più) — ogni chiamata qui è
 * avvolta in try/catch dal chiamante (weatherArpalCron.js): se il portale
 * cambia ancora, un cantiere torna semplicemente alla stima ERA5 esistente
 * finché qualcuno non aggiorna questo modulo, mai un errore fatale.
 */
const { parseArpalCsv } = require('./weatherService');
const { findNearestArpalStations } = require('../lib/arpalStations');

const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const BASE = 'https://ambientepub.regione.liguria.it/SiraQualMeteo/script';
const PRECIPITAZIONE_PARAM = 'PRECPBIWC1'; // "PRECIPITAZIONE - Precipitazione Cumulata" — vedi PubAccessoDatiMeteo13.asp

function isoToItalianDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function extractSetCookie(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

/**
 * Scarica il CSV di precipitazione ARPAL per una stazione e un range di
 * date, e lo parsa con lo stesso parser dell'upload manuale.
 * @param {string} stationCode - es. "ME00205" (data/arpal_stations.json)
 * @param {string} startDateISO - "YYYY-MM-DD"
 * @param {string} endDateISO - "YYYY-MM-DD"
 * @returns {Promise<{stationName: string, rows: Array<{date, precipitation_mm, valid}>}>}
 */
async function fetchArpalStationRange(stationCode, startDateISO, endDateISO) {
  const commonHeaders = { 'User-Agent': UA };

  // Passo 1: seleziona "Tipologia località = Stazione" → genera IdRichiesta
  // di sessione (server-side, legato al cookie).
  const selectRes = await fetch(`${BASE}/PubAccessoDatiMeteo12.asp`, {
    method: 'POST',
    headers: { ...commonHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'TipoTema=STAZIONE&Azione=&CodRete=&CodTema=STAZIONE',
    signal: AbortSignal.timeout(15000),
  });
  if (!selectRes.ok) throw new Error(`ARPAL step1 HTTP ${selectRes.status}`);
  const cookie = extractSetCookie(selectRes);
  if (!cookie) throw new Error('ARPAL step1: nessun cookie di sessione ricevuto');
  const selectHtml = await selectRes.text();
  const idRichiestaM = selectHtml.match(/NAME=IdRichiesta VALUE=(\d+)/);
  if (!idRichiestaM) throw new Error('ARPAL step1: IdRichiesta non trovato nella risposta');
  const idRichiesta = idRichiestaM[1];

  // Passo 2: registra la stazione scelta sulla sessione appena aperta.
  const withCookie = (extra = {}) => ({ ...commonHeaders, Cookie: cookie, ...extra });
  const pickRes = await fetch(`${BASE}/PubAccessoDatiMeteo12.asp`, {
    method: 'POST',
    headers: withCookie({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: `Azione=INSERISCI_TEMA&CodTema=STAZIONE&CodUbic=${encodeURIComponent(stationCode)}&IdRichiesta=${idRichiesta}&IdRichiestaCarto=&Frequenza=GG`,
    signal: AbortSignal.timeout(15000),
  });
  if (!pickRes.ok) throw new Error(`ARPAL step2 HTTP ${pickRes.status}`);

  // Passo 3: richiede l'estrazione — la risposta contiene il link al CSV
  // generato al volo (non il CSV stesso).
  const qs = new URLSearchParams({
    CodParam: PRECIPITAZIONE_PARAM,
    CodTema: 'STAZIONE',
    IdEstraz: 'DE',
    Frequenza: 'GG',
    TipoOutput: 'XLS',
    Separatore: ';',
    IdRichiesta: idRichiesta,
    IdRichiestaCarto: '',
    DataIniz: isoToItalianDate(startDateISO),
    InizOra: '00:00',
    DataFine: isoToItalianDate(endDateISO),
    FineOra: '23:59',
  });
  const extractRes = await fetch(`${BASE}/PubAccessoDatiMeteoPost.asp?${qs.toString()}`, {
    headers: withCookie(),
    signal: AbortSignal.timeout(30000),
  });
  if (!extractRes.ok) throw new Error(`ARPAL step3 HTTP ${extractRes.status}`);
  const extractHtml = await extractRes.text();
  const csvUrlM = extractHtml.match(/HREF="(https:\/\/ambientepub\.regione\.liguria\.it\/SiraQualMeteo\/report\/\d+\.csv)"/i);
  if (!csvUrlM) {
    // F-199: non tutte le stazioni misurano ogni parametro (es. GENOVA -
    // UNIVERSITA' non ha un pluviometro) — errore atteso e gestito dal
    // chiamante (arpalStationFallback.js) provando la stazione successiva
    // per distanza, non un guasto dello scraper.
    if (/nessun dato disponibile/i.test(extractHtml) || /nessun sensore/i.test(extractHtml)) {
      const err = new Error(`ARPAL: nessun dato di precipitazione per la stazione ${stationCode} nel periodo richiesto`);
      err.code = 'ARPAL_NO_DATA';
      throw err;
    }
    throw new Error('ARPAL step3: link al CSV non trovato nella risposta — il portale potrebbe aver cambiato formato');
  }

  // Passo 4: scarica il CSV vero e proprio.
  const csvRes = await fetch(csvUrlM[1], { headers: withCookie(), signal: AbortSignal.timeout(20000) });
  if (!csvRes.ok) throw new Error(`ARPAL step4 HTTP ${csvRes.status}`);
  const buffer = Buffer.from(await csvRes.arrayBuffer());

  return parseArpalCsv(buffer);
}

/**
 * Trova la precipitazione ARPAL per una posizione GPS, provando le stazioni
 * più vicine in ordine finché una risponde con dati reali (non tutte
 * misurano la precipitazione). Pensata per il cron automatico — un
 * fallimento di rete/portale su UNA stazione non deve far rinunciare
 * all'intero cantiere se ce n'è un'altra vicina che funziona.
 * @returns {Promise<{stationName: string, stationCode: string, distance_m: number, rows: Array}>}
 */
async function resolveArpalPrecipitation(lat, lon, startDateISO, endDateISO, stationCache = new Map()) {
  const candidates = findNearestArpalStations(lat, lon, 5);
  if (!candidates.length) {
    const err = new Error('Nessuna stazione ARPAL entro raggio utile da questa posizione');
    err.code = 'ARPAL_NO_STATION_NEARBY';
    throw err;
  }

  const errors = [];
  for (const candidate of candidates) {
    // Una stazione già segnata "senza dati" in questo giro di cron non va
    // ritentata per ogni cantiere che la condivide come più vicina.
    if (stationCache.get(candidate.code) === 'NO_DATA') { errors.push(`${candidate.name}: nessun dato (cache)`); continue; }
    try {
      const result = await fetchArpalStationRange(candidate.code, startDateISO, endDateISO);
      stationCache.set(candidate.code, 'OK');
      return { stationName: result.stationName, stationCode: candidate.code, distance_m: candidate.distance_m, rows: result.rows };
    } catch (err) {
      if (err.code === 'ARPAL_NO_DATA') stationCache.set(candidate.code, 'NO_DATA');
      errors.push(`${candidate.name}: ${err.message}`);
    }
  }
  const err = new Error(`Nessuna delle ${candidates.length} stazioni ARPAL più vicine ha dati di precipitazione: ${errors.join(' | ')}`);
  err.code = 'ARPAL_ALL_CANDIDATES_FAILED';
  throw err;
}

module.exports = { fetchArpalStationRange, resolveArpalPrecipitation };
