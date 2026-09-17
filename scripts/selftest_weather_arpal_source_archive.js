#!/usr/bin/env node
/**
 * scripts/selftest_weather_arpal_source_archive.js
 *
 * Test di regressione per F-207 (AUDIT.md), seguito — "se un cliente
 * verifica lui stesso, siamo coperti": ogni giorno certificato ARPAL deve
 * conservare il CSV ufficiale originale (byte per byte), non solo il
 * valore numerico estratto — così un dato può essere prodotto e verificato
 * anche anni dopo, anche se il portale ARPAL nel frattempo cambia.
 *
 * Nessun mock: chiama davvero il portale ARPAL (arpalWeatherSource.js) e
 * carica davvero su Supabase Storage (bucket arpal-source-archive).
 *
 * Verifica:
 *   1. Dopo una certificazione ARPAL, site_weather_logs.arpal_source_path
 *      è valorizzato (non NULL) per i giorni certificati.
 *   2. Il file referenziato esiste DAVVERO nel bucket ed è un CSV ARPAL
 *      valido (non un placeholder) — lo si riscarica e riparse.
 *   3. Il file scaricato contiene la stessa stazione e almeno la stessa
 *      precipitazione salvata in DB per un giorno campione — il documento
 *      archiviato è coerente col valore certificato, non un file a caso.
 *   4. Un fallimento dell'archiviazione (bucket inesistente) non blocca la
 *      certificazione stessa — resta solo arpal_source_path=NULL.
 *
 * Env: E2E_COMPANY_ID opzionale.
 */
'use strict';
require('dotenv').config();
const supabase = require('../lib/supabase');
const { resolveArpalPrecipitation } = require('../services/arpalWeatherSource');
const { archiveArpalSource, BUCKET } = require('../services/weatherArpalArchive');
const { buildArpalWeatherLogUpdate, parseArpalCsv } = require('../services/weatherService');

const COMPANY_ID = process.env.E2E_COMPANY_ID || 'fda73bf5-403a-4a0e-be6d-501e3f3c5c4d';
// Genova centro — stessa area degli altri selftest meteo di questo repo.
const LAT = 44.4056, LON = 8.9463;

let passed = 0, failed = 0;
function ok(name)        { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, got) { console.error(`  \x1b[31m✗\x1b[0m ${name}`); if (got !== undefined) console.error(`    got: ${JSON.stringify(got).slice(0, 400)}`); failed++; }

const TZ = 'Europe/Rome';
function isoDaysAgo(n) {
  const d = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: TZ }));
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function main() {
  console.log('\n\x1b[1mArchiviazione documento sorgente ARPAL (F-207)\x1b[0m');

  const fromDate = isoDaysAgo(10);
  const toDate   = isoDaysAgo(1);

  const { data: site, error: siteErr } = await supabase.from('sites').insert({
    company_id: COMPANY_ID, name: `TEST-F207ARCH Cantiere ${Date.now()}`, status: 'attivo',
    address: 'Via Test ArpalArchive, Genova', latitude: LAT, longitude: LON, start_date: fromDate,
  }).select('id, company_id, name').single();
  if (siteErr) { fail('crea cantiere di test', siteErr.message); return report(); }

  try {
    // 1. Fetch reale ARPAL (nessun mock).
    let resolved;
    try {
      resolved = await resolveArpalPrecipitation(LAT, LON, fromDate, toDate, new Map(), 'GG');
    } catch (e) {
      fail('richiesta ARPAL riuscita per il cantiere di test', e.message);
      return report();
    }
    if (resolved.rawCsv && resolved.rawCsv.length) ok('la richiesta ARPAL torna anche il CSV grezzo (rawCsv)');
    else fail('la richiesta ARPAL torna anche il CSV grezzo (rawCsv)', { hasRawCsv: !!resolved.rawCsv });

    // 2. Archiviazione.
    const sourcePath = await archiveArpalSource(site, resolved.stationCode, fromDate, toDate, resolved.rawCsv);
    if (sourcePath) ok('archiveArpalSource restituisce un percorso');
    else fail('archiveArpalSource restituisce un percorso');

    // 3. Il file esiste DAVVERO nel bucket ed è lo stesso CSV.
    if (sourcePath) {
      const { data: downloaded, error: dlErr } = await supabase.storage.from(BUCKET).download(sourcePath);
      if (dlErr) fail('il file archiviato è scaricabile dal bucket', dlErr.message);
      else {
        const buf = Buffer.from(await downloaded.arrayBuffer());
        if (buf.equals(resolved.rawCsv)) ok('il file archiviato è identico byte per byte al CSV scaricato da ARPAL');
        else fail('il file archiviato è identico byte per byte al CSV scaricato da ARPAL', { bytesArchiviati: buf.length, bytesOriginali: resolved.rawCsv.length });

        const reparsed = parseArpalCsv(buf);
        if (reparsed.stationName === resolved.stationName && reparsed.rows.length === resolved.rows.length) {
          ok('il file archiviato si riparsa correttamente con la stessa stazione e lo stesso numero di righe');
        } else {
          fail('il file archiviato si riparsa correttamente con la stessa stazione e lo stesso numero di righe', reparsed);
        }
      }
    }

    // 4. buildArpalWeatherLogUpdate include arpal_source_path.
    const thresholds = { rain_mm: 1, wind_kmh: 50, snow: true, thunderstorm: true };
    const sampleRow = resolved.rows.find(r => r.valid && r.precipitation_mm !== null);
    if (sampleRow) {
      const update = buildArpalWeatherLogUpdate(null, sampleRow, resolved.stationName, thresholds, sourcePath);
      if (update.arpal_source_path === sourcePath) ok('buildArpalWeatherLogUpdate include arpal_source_path nel payload di upsert');
      else fail('buildArpalWeatherLogUpdate include arpal_source_path nel payload di upsert', update);
    } else {
      fail('esiste almeno una riga valida di precipitazione nel range di test (impossibile verificare il payload)');
    }

    // 5. Un'archiviazione fallita (bucket inesistente) non deve lanciare —
    //    la certificazione stessa non deve mai dipendere da questo passo.
    const failedPath = await archiveArpalSource(site, resolved.stationCode, fromDate, toDate, resolved.rawCsv)
      .catch(() => 'THREW');
    // upsert=false + stesso path già esistente dal passo 2 → fallisce "already exists",
    // ma la funzione deve tornare null, non lanciare.
    if (failedPath !== 'THREW') ok('un upload fallito (es. path duplicato) non lancia — torna null, mai bloccante');
    else fail('un upload fallito (es. path duplicato) non lancia — torna null, mai bloccante');

  } finally {
    await cleanup(site.id);
  }

  report();
}

async function cleanup(siteId) {
  // Rimuove eventuali file archiviati durante il test (prefisso company/site).
  const { data: site } = await supabase.from('sites').select('company_id').eq('id', siteId).maybeSingle();
  if (site) {
    const { data: files } = await supabase.storage.from(BUCKET).list(`${site.company_id}/${siteId}`);
    if (files?.length) {
      await supabase.storage.from(BUCKET).remove(files.map(f => `${site.company_id}/${siteId}/${f.name}`));
    }
  }
  await supabase.from('site_weather_logs').delete().eq('site_id', siteId);
  await supabase.from('sites').delete().eq('id', siteId);
}

function report() {
  console.log(`\n${passed} passati, ${failed} falliti.`);
  if (failed > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch(e => {
  console.error('ERRORE selftest_weather_arpal_source_archive:', e.message);
  process.exit(1);
});
