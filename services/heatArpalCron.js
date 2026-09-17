'use strict';
/**
 * services/heatArpalCron.js
 *
 * Certificazione automatica giorni di caldo — richiesta esplicita del
 * titolare (2026-09-17), base normativa D.L. 107/2026 art. 6 + messaggio
 * INPS 2418/2026 (vedi migrations/218 per i dettagli, incluso perché NON è
 * il "bollino rosso"). Ogni giorno alle 05:30 (dopo weatherArpalCron delle
 * 05:15), per ogni cantiere con GPS:
 *   1. Trova il giorno più vecchio NON ancora certificato per quel
 *      cantiere (mai i giorni già in site_heat_logs — niente fase di
 *      "stima preliminare" da riconciliare come per la pioggia: qui non
 *      esiste una fonte alternativa, il dato nasce già certificato ARPAL).
 *   2. Scarica temperatura/umidità/radiazione dalla stazione ARPAL più
 *      vicina (arpalHeatSource.js), stima il WBGT (lib/heatIndex.js),
 *      valuta la soglia interna del cantiere.
 *   3. Archivia il CSV originale (stesso bucket/meccanismo di F-207,
 *      services/weatherArpalArchive.js — generico, non specifico pioggia).
 *   4. Notifica se emergono nuovi giorni sopra soglia.
 *
 * Un fallimento su un cantiere (rete, nessuna stazione vicina) non blocca
 * gli altri né lascia il cantiere senza nulla — si ritenta al prossimo
 * giro, stesso principio di weatherArpalCron.js.
 */
const cron     = require('node-cron');
const supabase = require('../lib/supabase');
const { resolveArpalHeat }  = require('./arpalHeatSource');
const { estimateWbgt }      = require('../lib/heatIndex');
const { archiveArpalSource } = require('./weatherArpalArchive');

const CRON_SCHEDULE = '30 5 * * *'; // 05:30 — dopo weatherArpalCron (05:15)
const TZ = 'Europe/Rome';
// Se un cantiere non ha start_date, non si torna indietro all'infinito —
// stesso principio di backfill limitato già in uso altrove in questo repo.
const MAX_BACKFILL_DAYS = 180;

function yesterdayISO() {
  const d = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: TZ }));
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}
function shiftDateStr(yyyymmdd, days) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

async function upsertHeatNotification(companyId, siteId, siteName, pendingDays) {
  if (pendingDays.length === 0) {
    await supabase.from('notifications').delete()
      .eq('company_id', companyId).eq('entity_type', 'site').eq('entity_id', siteId).eq('type', 'heat_suspension');
    return;
  }
  const sorted = [...pendingDays].sort();
  const listIt = sorted.map(d => new Date(d + 'T00:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }));
  const title = `Caldo — ${pendingDays.length} ${pendingDays.length === 1 ? 'giornata da confermare' : 'giornate da confermare'}`;
  const body  = `${siteName}\n${listIt.join(' · ')}\nVai al cantiere → Caldo per confermare o ignorare.`;
  await supabase.from('notifications').upsert({
    company_id: companyId, type: 'heat_suspension', severity: 'warning', title, body,
    entity_type: 'site', entity_id: siteId, updated_at: new Date().toISOString(),
  }, { onConflict: 'company_id,entity_type,entity_id,type' });
}

async function heatizeSite(site, stationCache, companyThresholdMap) {
  const { data: latest } = await supabase.from('site_heat_logs')
    .select('log_date').eq('site_id', site.id).order('log_date', { ascending: false }).limit(1).maybeSingle();

  const maxDate = yesterdayISO();
  const earliestAllowed = shiftDateStr(maxDate, -MAX_BACKFILL_DAYS);
  let minDate = latest?.log_date ? shiftDateStr(latest.log_date, 1) : (site.start_date || earliestAllowed);
  if (minDate < earliestAllowed) minDate = earliestAllowed;
  if (minDate > maxDate) return { imported: 0, newlyExceeded: [], station: null };

  const resolved = await resolveArpalHeat(site.latitude, site.longitude, minDate, maxDate, stationCache);

  const sourcePath = await archiveArpalSource(
    site, resolved.stationCode, minDate, maxDate, resolved.rawCsvByFactor?.temp_max_c
  );

  const thresholdC = site.heat_temp_threshold_c ?? companyThresholdMap?.get(site.company_id) ?? 35;
  const dates = [...resolved.byFactor.temp_max_c.keys()].sort();
  const rows = [];
  for (const date of dates) {
    const temp      = resolved.byFactor.temp_max_c.get(date);
    const humidity   = resolved.byFactor.humidity_pct?.get(date) ?? null;
    const radiation  = resolved.byFactor.solar_radiation_jcm2?.get(date) ?? null;
    const wbgt       = humidity != null ? estimateWbgt(temp, humidity) : null;
    const exceeded   = temp >= thresholdC;
    rows.push({
      company_id: site.company_id, site_id: site.id, log_date: date,
      temp_max_c: temp, humidity_pct: humidity, solar_radiation_jcm2: radiation, wbgt_estimate_c: wbgt,
      threshold_exceeded: exceeded, threshold_reason: exceeded ? 'temperatura' : null,
      arpal_station_name: resolved.stationName, arpal_source_path: sourcePath || null,
      fetched_at: new Date().toISOString(),
    });
  }
  if (!rows.length) return { imported: 0, newlyExceeded: [], station: { name: resolved.stationName } };

  const { error } = await supabase.from('site_heat_logs').upsert(rows, { onConflict: 'site_id,log_date' });
  if (error) throw new Error(error.message);

  return {
    imported: rows.length,
    newlyExceeded: rows.filter(r => r.threshold_exceeded).map(r => r.log_date),
    station: { name: resolved.stationName, code: resolved.stationCode, distance_m: resolved.distance_m },
  };
}

async function runHeatArpalCron() {
  console.log('[heatArpal] Avvio certificazione caldo cantieri');

  const { data: sites, error } = await supabase.from('sites')
    .select('id, company_id, name, latitude, longitude, start_date, heat_temp_threshold_c, heat_alert_enabled')
    .in('status', ['attivo', 'sospeso'])
    .not('latitude', 'is', null).not('longitude', 'is', null)
    .eq('heat_alert_enabled', true);

  if (error) { console.error('[heatArpal] errore caricamento cantieri:', error.message); return; }
  if (!sites?.length) { console.log('[heatArpal] nessun cantiere con GPS/allerta caldo attiva'); return; }

  const companyIds = [...new Set(sites.map(s => s.company_id))];
  const { data: companies } = await supabase.from('companies').select('id, heat_temp_threshold_c').in('id', companyIds);
  const companyThresholdMap = new Map((companies || []).map(c => [c.id, c.heat_temp_threshold_c]));

  const stationCache = new Map();
  let sitesUpdated = 0, sitesFailed = 0, totalImported = 0, totalNewAlerts = 0;

  for (const site of sites) {
    try {
      const r = await heatizeSite(site, stationCache, companyThresholdMap);
      if (r.imported > 0) {
        sitesUpdated++; totalImported += r.imported;
        console.log(`[heatArpal] ${site.name}: ${r.imported} giorni da ${r.station?.name || '?'}`);
        if (r.newlyExceeded.length) {
          totalNewAlerts += r.newlyExceeded.length;
          const { data: pendingRows } = await supabase.from('site_heat_logs')
            .select('log_date').eq('site_id', site.id)
            .eq('threshold_exceeded', true).eq('suspension_confirmed', false).eq('suspension_dismissed', false);
          await upsertHeatNotification(site.company_id, site.id, site.name || 'Cantiere', (pendingRows || []).map(p => p.log_date));
        }
      }
    } catch (err) {
      sitesFailed++;
      console.error(`[heatArpal] ${site.name}: ${err.message}`);
    }
  }

  console.log(`[heatArpal] Completato: ${sitesUpdated} cantieri aggiornati (${totalImported} giorni, ${totalNewAlerts} nuovi da confermare), ${sitesFailed} falliti`);
}

function startHeatArpalCron() {
  cron.schedule(CRON_SCHEDULE, () => runHeatArpalCron(), { timezone: TZ });
  console.log('[heatArpal] Cron avviato —', CRON_SCHEDULE, TZ);
}

module.exports = { startHeatArpalCron, runHeatArpalCron, heatizeSite, upsertHeatNotification };
