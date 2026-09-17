'use strict';
/**
 * services/arpalHeatSource.js
 *
 * Fetch AUTOMATICO di temperatura massima, umidità relativa e radiazione
 * solare certificate ARPAL — richiesta esplicita del titolare (2026-09-17):
 * "serve calcolare con la massima verità legale i giorni di caldo... deve
 * essere chirurgico". Base normativa verificata: D.L. 26/06/2026 n. 107
 * art. 6 + messaggio INPS n. 2418/2026 (non il "bollino rosso" — non è più
 * il criterio corretto, la norma richiede una relazione tecnica
 * multi-fattore, non una soglia singola). Vedi migrations/218 per i
 * dettagli e le fonti scartate (Worklimate: solo previsioni, nessun dato
 * storico, verificato dal vivo).
 *
 * Stessa identica meccanica di sessione di services/arpalWeatherSource.js
 * (stesso portale, stesso IdRichiesta) — non fattorizzata insieme
 * deliberatamente: la pioggia è un percorso già in produzione, verificato
 * e stabile; questo modulo è nuovo, tenerlo separato significa che un
 * problema qui non può mai toccare la certificazione pioggia già
 * funzionante. Tre parametri nella STESSA sessione (station registration
 * una volta sola, poi tre estrazioni) — verificato dal vivo che il
 * portale lo permette, nessun bisogno di tre sessioni separate.
 */
const { findNearestArpalStations } = require('../lib/arpalStations');

const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const BASE = 'https://ambientepub.regione.liguria.it/SiraQualMeteo/script';

// Codici parametro verificati dal vivo sul portale (PubAccessoDatiMeteo13.asp,
// dropdown per la stazione GENOVA - CENTRO FUNZIONALE, 2026-09-17) — non
// tutte le stazioni misurano tutti e tre (stessa cautela già nota per la
// precipitazione), il chiamante prova le stazioni vicine in ordine.
const PARAMS = {
  temp_max_c:           'TEMPTRMWC4', // TEMPERATURA - Temperatura Massima Assoluta Dell'Aria (°C)
  humidity_pct:         'UMREIGRWCL', // UMIDITA RELATIVA - Umidità Relativa Media Dell'Aria (%)
  solar_radiation_jcm2: 'RSTORDTWCL', // RADIAZIONE SOLARE - Radiazione Solare Giornaliera (J/cm²)
};

function isoToItalianDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function extractSetCookie(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

/**
 * Parser CSV generico per il formato ARPAL (stesso identico formato del
 * CSV precipitazione, vedi weatherService.js::parseArpalCsv — qui senza il
 * vincolo "il Parametro deve contenere PRECIPITAZ", perché questo modulo
 * gestisce parametri diversi).
 * @returns {{stationName: string, parametro: string, rows: Array<{date, value: number|null, valid: boolean}>}}
 */
function parseArpalGenericCsv(buffer) {
  const text  = buffer.toString('latin1');
  const lines = text.split(/\r\n|\n/);

  let stationName = null, parametro = null;
  const rows = [];
  let inTable = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { if (inTable) break; continue; }

    if (line.startsWith('"Stazione"')) {
      const idx = line.indexOf(',');
      stationName = idx >= 0 ? line.slice(idx + 1).replace(/^"|"$/g, '').trim() : null;
      continue;
    }
    if (line.startsWith('"Parametro"')) {
      const idx = line.indexOf(',');
      parametro = idx >= 0 ? line.slice(idx + 1).replace(/^"|"$/g, '').trim() : null;
      continue;
    }
    if (line.startsWith('"Inizio rilevazione"')) { inTable = true; continue; }
    if (line.startsWith('"Dati letti"') || line.startsWith('"Dati validi"')) { inTable = false; continue; }

    if (inTable) {
      const cols = line.split('","').map(c => c.replace(/^"|"$/g, ''));
      if (cols.length < 5) continue;
      const [inizio, , valore, , valido] = cols;
      const m = inizio.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!m) continue;
      const date = `${m[3]}-${m[2]}-${m[1]}`;
      const num  = Number(valore);
      rows.push({ date, value: Number.isFinite(num) ? num : null, valid: /^s/i.test(valido || '') });
    }
  }

  if (!stationName) throw new Error('CSV ARPAL non riconosciuto: manca la riga "Stazione".');
  if (!rows.length) throw new Error('Nessuna riga di dati trovata nel CSV.');
  return { stationName, parametro, rows };
}

async function registerStationSession(stationCode) {
  const selectRes = await fetch(`${BASE}/PubAccessoDatiMeteo12.asp`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
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

  const withCookie = (extra = {}) => ({ 'User-Agent': UA, Cookie: cookie, ...extra });
  const pickRes = await fetch(`${BASE}/PubAccessoDatiMeteo12.asp`, {
    method: 'POST',
    headers: withCookie({ 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: `Azione=INSERISCI_TEMA&CodTema=STAZIONE&CodUbic=${encodeURIComponent(stationCode)}&IdRichiesta=${idRichiesta}&IdRichiestaCarto=&Frequenza=GG`,
    signal: AbortSignal.timeout(15000),
  });
  if (!pickRes.ok) throw new Error(`ARPAL step2 HTTP ${pickRes.status}`);

  return { idRichiesta, withCookie };
}

async function extractParam({ idRichiesta, withCookie }, codParam, startDateISO, endDateISO) {
  const qs = new URLSearchParams({
    CodParam: codParam, CodTema: 'STAZIONE', IdEstraz: 'DE', Frequenza: 'GG', TipoOutput: 'XLS', Separatore: ';',
    IdRichiesta: idRichiesta, IdRichiestaCarto: '',
    DataIniz: isoToItalianDate(startDateISO), InizOra: '00:00',
    DataFine: isoToItalianDate(endDateISO), FineOra: '23:59',
  });
  const extractRes = await fetch(`${BASE}/PubAccessoDatiMeteoPost.asp?${qs.toString()}`, {
    headers: withCookie(), signal: AbortSignal.timeout(30000),
  });
  if (!extractRes.ok) throw new Error(`ARPAL step3 HTTP ${extractRes.status}`);
  const extractHtml = await extractRes.text();
  const csvUrlM = extractHtml.match(/HREF="(https:\/\/ambientepub\.regione\.liguria\.it\/SiraQualMeteo\/report\/\d+\.csv)"/i);
  if (!csvUrlM) {
    if (/nessun dato disponibile/i.test(extractHtml) || /nessun sensore/i.test(extractHtml)) {
      const err = new Error(`ARPAL: nessun dato per il parametro ${codParam} nel periodo richiesto`);
      err.code = 'ARPAL_NO_DATA';
      throw err;
    }
    throw new Error('ARPAL step3: link al CSV non trovato — il portale potrebbe aver cambiato formato');
  }
  const csvRes = await fetch(csvUrlM[1], { headers: withCookie(), signal: AbortSignal.timeout(20000) });
  if (!csvRes.ok) throw new Error(`ARPAL step4 HTTP ${csvRes.status}`);
  const buffer = Buffer.from(await csvRes.arrayBuffer());
  return { ...parseArpalGenericCsv(buffer), rawCsv: buffer };
}

/**
 * Scarica temperatura max, umidità e radiazione solare per UNA stazione e
 * un range di date, nella stessa sessione. Un parametro mancante su questa
 * stazione (es. niente pluviometro/piranometro) non blocca gli altri due —
 * torna null per quello, il chiamante decide se è sufficiente.
 * @returns {Promise<{stationName: string, byFactor: {temp_max_c, humidity_pct, solar_radiation_jcm2}, rawCsvByFactor: object}>}
 */
async function fetchArpalHeatFactors(stationCode, startDateISO, endDateISO) {
  const session = await registerStationSession(stationCode);
  const byFactor = {};
  const rawCsvByFactor = {};
  let stationName = null;
  const errors = [];

  for (const [factor, codParam] of Object.entries(PARAMS)) {
    try {
      const result = await extractParam(session, codParam, startDateISO, endDateISO);
      stationName = stationName || result.stationName;
      byFactor[factor] = new Map(result.rows.filter(r => r.valid && r.value !== null).map(r => [r.date, r.value]));
      rawCsvByFactor[factor] = result.rawCsv;
    } catch (err) {
      byFactor[factor] = new Map();
      errors.push(`${factor}: ${err.message}`);
    }
  }

  if (!stationName) {
    const err = new Error(`ARPAL: nessuno dei 3 parametri caldo disponibile per la stazione ${stationCode} — ${errors.join(' | ')}`);
    err.code = 'ARPAL_NO_DATA';
    throw err;
  }
  return { stationName, byFactor, rawCsvByFactor, partialErrors: errors };
}

/**
 * Trova i dati caldo ARPAL per una posizione GPS, provando le stazioni più
 * vicine finché almeno la temperatura è disponibile (temperatura+umidità
 * sono le due grandezze indispensabili per la relazione tecnica; la
 * radiazione, quando manca, non impedisce la certificazione).
 * @returns {Promise<{stationName, stationCode, distance_m, byFactor, rawCsvByFactor}>}
 */
async function resolveArpalHeat(lat, lon, startDateISO, endDateISO, stationCache = new Map()) {
  const candidates = findNearestArpalStations(lat, lon, 5);
  if (!candidates.length) {
    const err = new Error('Nessuna stazione ARPAL entro raggio utile da questa posizione');
    err.code = 'ARPAL_NO_STATION_NEARBY';
    throw err;
  }

  const errors = [];
  for (const candidate of candidates) {
    if (stationCache.get(candidate.code) === 'NO_HEAT_DATA') { errors.push(`${candidate.name}: nessun dato (cache)`); continue; }
    try {
      const result = await fetchArpalHeatFactors(candidate.code, startDateISO, endDateISO);
      if (!result.byFactor.temp_max_c || result.byFactor.temp_max_c.size === 0) {
        stationCache.set(candidate.code, 'NO_HEAT_DATA');
        errors.push(`${candidate.name}: nessuna temperatura`);
        continue;
      }
      stationCache.set(candidate.code, 'OK');
      return { stationName: result.stationName, stationCode: candidate.code, distance_m: candidate.distance_m, ...result };
    } catch (err) {
      if (err.code === 'ARPAL_NO_DATA') stationCache.set(candidate.code, 'NO_HEAT_DATA');
      errors.push(`${candidate.name}: ${err.message}`);
    }
  }
  const err = new Error(`Nessuna delle ${candidates.length} stazioni ARPAL più vicine ha dati di temperatura: ${errors.join(' | ')}`);
  err.code = 'ARPAL_ALL_CANDIDATES_FAILED';
  throw err;
}

module.exports = { fetchArpalHeatFactors, resolveArpalHeat, parseArpalGenericCsv, PARAMS };
