'use strict';
/**
 * services/weatherArpalArchive.js
 *
 * F-207 (AUDIT.md), seguito: "se poi un cliente chiede e verifica lui
 * stesso, siamo coperti e tutelati dai dati Palladia" — richiesta esplicita
 * del titolare dopo aver verificato dal vivo che i valori certificati ARPAL
 * coincidono col portale ufficiale, in quel momento. Fino a qui
 * certificavamo solo il NUMERO estratto (precipitation_mm) + nome stazione
 * + timestamp: prova sufficiente finché nessuno la contesta, ma non un
 * documento che potremmo produrre se qualcuno lo facesse fra qualche anno,
 * magari con il portale ARPAL nel frattempo cambiato o irraggiungibile.
 *
 * archiveArpalSource() carica il CSV ufficiale, byte per byte, nel bucket
 * privato `arpal-source-archive` — lo stesso identico file che un cliente
 * otterrebbe scaricandolo lui stesso dal portale con la stessa stazione e
 * lo stesso range di date, non una nostra trascrizione.
 *
 * Deliberatamente MAI bloccante: un fallimento dell'upload (storage giù,
 * quota esaurita) non deve impedire la certificazione ARPAL stessa — quel
 * dato resta comunque vero e verificabile sul portale, solo senza la copia
 * archiviata (site_weather_logs.arpal_source_path resta NULL per quel giro,
 * si ritenterà al prossimo).
 */
const supabase = require('../lib/supabase');

const BUCKET = 'arpal-source-archive';

/**
 * @param {{id: string, company_id: string}} site
 * @param {string} stationCode
 * @param {string} fromDateISO
 * @param {string} toDateISO
 * @param {Buffer|undefined} rawCsv
 * @returns {Promise<string|null>} percorso nel bucket, o null se non archiviato
 */
async function archiveArpalSource(site, stationCode, fromDateISO, toDateISO, rawCsv) {
  if (!rawCsv || !rawCsv.length) return null;

  const path = `${site.company_id}/${site.id}/${stationCode}_${fromDateISO}_${toDateISO}_${Date.now()}.csv`;
  try {
    const { error } = await supabase.storage.from(BUCKET).upload(path, rawCsv, {
      contentType: 'text/csv',
      upsert: false,
    });
    if (error) {
      console.error('[weatherArpalArchive] upload fallito —', error.message);
      return null;
    }
    return path;
  } catch (e) {
    console.error('[weatherArpalArchive] upload fallito —', e.message);
    return null;
  }
}

module.exports = { archiveArpalSource, BUCKET };
