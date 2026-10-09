'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt }              = require('../../middleware/verifyJwt');
const { getActualWeather, buildWeatherLogUpdate, dataSourceRank } = require('../../services/weatherService');
const { backfillSiteWeatherHistory, yesterdayISO } = require('../../services/weatherBackfill');
const { confirmSuspension, dismissSuspension, undoSuspension } = require('../../lib/weatherSuspension');
const { generateWeatherReportHtml, generateWeatherReportXlsx } = require('../../services/weatherReport');
const { rendererPool }                   = require('../../pdf-renderer');
const { validate } = require('../../middleware/validate');
const { fetchWeatherSchema, confirmSuspensionSchema } = require('../../lib/schemas/siteWeather');

// ── Utility ────────────────────────────────────────────────────────────────────

/** Costruisce l'oggetto soglie dal record site (usa default se colonne null) */
function siteThresholds(site) {
  return {
    rain_mm:      site.weather_rain_mm      ?? 1,
    wind_kmh:     site.weather_wind_kmh     ?? 50,
    snow:         site.weather_snow         ?? true,
    thunderstorm: site.weather_thunderstorm ?? true,
  };
}


async function getSiteOrFail(siteId, companyId, res) {
  const { data } = await supabase
    .from('sites')
    .select('id, name, address, comune, client, start_date, end_date, contract_days, days_type, latitude, longitude, weather_rain_mm, weather_wind_kmh, weather_snow, weather_thunderstorm')
    .eq('id', siteId)
    .eq('company_id', companyId)
    .neq('status', 'eliminato')
    .maybeSingle();
  if (!data) { res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' }); return null; }
  return data;
}

// ── GET /api/v1/sites/:siteId/weather-log ─────────────────────────────────────
// Storico dati meteo salvati. Opzionale ?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/sites/:siteId/weather-log', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { from, to } = req.query;

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  let q = supabase
    .from('site_weather_logs')
    .select('id, log_date, precipitation_mm, wind_max_kmh, temp_min_c, temp_max_c, weather_code, weather_desc, threshold_exceeded, threshold_reason, suspension_confirmed, suspension_dismissed, suspension_id, fetched_at, data_source, era5_reconciled_at, era5_discrepancy, precipitation_mm_original, wind_max_kmh_original, weather_code_original, arpal_station_name, arpal_imported_at, precipitation_mm_full_day')
    .eq('site_id', siteId)
    .order('log_date', { ascending: false })
    // F-199 (AUDIT.md): 365 nascondeva cantieri più vecchi di un anno oltre
    // il preset "tutto" del frontend — un cantiere pluriennale (raro ma
    // reale) restava troncato anche selezionando l'intervallo libero.
    .limit(1100);

  if (from) q = q.gte('log_date', from);
  if (to)   q = q.lte('log_date', to);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── POST /api/v1/sites/:siteId/weather-log/fetch ──────────────────────────────
// Fetch manuale dei dati meteo per una o più date (backfill o aggiornamento).
// Body: { dates: ['YYYY-MM-DD', ...] }
router.post('/sites/:siteId/weather-log/fetch', verifySupabaseJwt, validate(fetchWeatherSchema), async (req, res) => {
  const { siteId } = req.params;
  const { dates }  = req.body || {};

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  if (!site.latitude || !site.longitude) {
    return res.status(400).json({ error: 'NO_COORDS', message: 'Imposta le coordinate GPS del cantiere prima.' });
  }

  const targetDates = Array.isArray(dates) && dates.length
    ? dates.slice(0, 30) // max 30 date per chiamata
    : [new Date(Date.now() - 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })]; // ieri

  const results = [];
  for (const d of targetDates) {
    try {
      const weather = await getActualWeather(site.latitude, site.longitude, d);

      // F-159 (AUDIT.md): se il giorno è già stato deciso da un umano
      // (confermato/ignorato), non aggiornare il verdetto — vedi
      // buildWeatherLogUpdate.
      const { data: existing } = await supabase
        .from('site_weather_logs')
        .select('suspension_confirmed, suspension_dismissed, threshold_exceeded, precipitation_mm, wind_max_kmh, weather_code, data_source, era5_reconciled_at, precipitation_mm_original, wind_max_kmh_original, weather_code_original')
        .eq('site_id', siteId).eq('log_date', d).maybeSingle();

      const update = buildWeatherLogUpdate(existing, weather, siteThresholds(site));
      // F-200 (AUDIT.md): il guard di precedenza in buildWeatherLogUpdate può
      // ridurre l'update a solo fetched_at (fonte più autorevole già in DB) —
      // il chiamante deve poterlo distinguere da un aggiornamento vero, senza
      // dover ripetere la logica di precedenza: il frontend usa "blocked" per
      // non mostrare "Dati meteo aggiornati" quando in realtà non è cambiato
      // nulla (F-199: "è così che guadagniamo la fiducia di tutti").
      const blocked = !!existing && dataSourceRank(existing.data_source) > dataSourceRank(weather.data_source);

      const { data: row } = await supabase
        .from('site_weather_logs')
        .upsert({ company_id: req.companyId, site_id: siteId, log_date: d, ...update }, { onConflict: 'site_id,log_date' })
        .select()
        .single();

      results.push({ date: d, ok: true, data: row, blocked });
    } catch (err) {
      results.push({ date: d, ok: false, error: err.message });
    }
  }

  res.json({ results });
});

// ── POST /api/v1/sites/:siteId/weather-log/backfill ──────────────────────────
// Scarica TUTTO lo storico meteo dall'inizio cantiere a ieri in un'unica chiamata ERA5.
// Idempotente: sicuro da richiamare più volte (upsert). Non sovrascrive sospensioni già confermate.
router.post('/sites/:siteId/weather-log/backfill', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  // F-207 (AUDIT.md): logica condivisa con il cron — vedi
  // services/weatherBackfill.js.
  const yesterday = yesterdayISO();
  if (site.start_date && site.start_date > yesterday)
    return res.json({ inserted: 0, suspension_alerts: 0, message: 'Cantiere non ancora iniziato — nessuno storico disponibile.' });

  try {
    const result = await backfillSiteWeatherHistory({ ...site, company_id: req.companyId });
    res.json({ inserted: result.inserted, updated: result.updated, unchanged: result.unchanged, suspension_alerts: result.suspension_alerts });
  } catch (err) {
    if (err.code === 'NO_COORDS')     return res.status(400).json({ error: 'NO_COORDS', message: err.message });
    if (err.code === 'NO_START_DATE') return res.status(400).json({ error: 'NO_START_DATE', message: err.message });
    console.error('[weatherBackfill]', err.message);
    res.status(502).json({ error: 'WEATHER_API_ERROR', message: err.message });
  }
});

// ── POST /api/v1/sites/:siteId/weather-log/:date/confirm ─────────────────────
// Conferma sospensione: crea il giorno in site_suspension_days + aggiorna log.
// Logica in lib/weatherSuspension.js (F-318: la usa anche "Pioggia da confermare").
router.post('/sites/:siteId/weather-log/:date/confirm', verifySupabaseJwt, validate(confirmSuspensionSchema), async (req, res) => {
  const { siteId, date } = req.params;
  const { notes }        = req.body || {};
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;
  const r = await confirmSuspension({ companyId: req.companyId, site, date, notes, userId: req.user?.id ?? null });
  res.status(r.status).json(r.body);
});

// ── POST /api/v1/sites/:siteId/weather-log/:date/dismiss ─────────────────────
router.post('/sites/:siteId/weather-log/:date/dismiss', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;
  const r = await dismissSuspension({ companyId: req.companyId, site, date });
  res.status(r.status).json(r.body);
});

// ── POST /api/v1/sites/:siteId/weather-log/:date/undo ────────────────────────
// Annulla una sospensione confermata per errore.
// Elimina da site_suspension_days, azzera i flag sul log, ricalcola end_date.
router.post('/sites/:siteId/weather-log/:date/undo', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;
  const r = await undoSuspension({ companyId: req.companyId, site, date });
  res.status(r.status).json(r.body);
});

// ── GET /api/v1/sites/:siteId/weather-report.xlsx ────────────────────────────
// F-199 (AUDIT.md): "se metto nei filtri 'soglie superate'... e poi vado ad
// esportare il PDF, io voglio vedere solo quei dati" — filter opzionale
// (critical|confirmed) applicato oltre a from/to, stessa semantica dei
// pulsanti filtro nella scheda Meteo (SiteWeatherSection.tsx).
router.get('/sites/:siteId/weather-report.xlsx', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { from, to, filter } = req.query;

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  let q = supabase
    .from('site_weather_logs')
    .select('log_date, precipitation_mm, precipitation_mm_full_day, wind_max_kmh, temp_min_c, temp_max_c, weather_desc, threshold_exceeded, threshold_reason, suspension_confirmed, suspension_dismissed, data_source, era5_discrepancy, precipitation_mm_original, wind_max_kmh_original')
    .eq('site_id', siteId)
    .order('log_date', { ascending: true });

  if (from) q = q.gte('log_date', from);
  if (to)   q = q.lte('log_date', to);
  if (filter === 'critical')  q = q.eq('threshold_exceeded', true);
  if (filter === 'confirmed') q = q.eq('suspension_confirmed', true);

  const { data: logs } = await q;
  const rows = logs || [];
  const wb = generateWeatherReportXlsx({ site, rows, thresholds: siteThresholds(site), from, to, filter });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="meteo_${siteId}_${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ── GET /api/v1/sites/:siteId/weather-report.pdf ─────────────────────────────
// F-199 (AUDIT.md): stesso filtro category dell'export xlsx sopra.
router.get('/sites/:siteId/weather-report.pdf', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { from, to, filter } = req.query;

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  let q = supabase
    .from('site_weather_logs')
    .select('log_date, precipitation_mm, precipitation_mm_full_day, wind_max_kmh, temp_min_c, temp_max_c, weather_desc, weather_code, threshold_exceeded, threshold_reason, suspension_confirmed, suspension_dismissed, data_source, era5_discrepancy')
    .eq('site_id', siteId)
    .order('log_date', { ascending: true });

  if (from) q = q.gte('log_date', from);
  if (to)   q = q.lte('log_date', to);
  if (filter === 'critical')  q = q.eq('threshold_exceeded', true);
  if (filter === 'confirmed') q = q.eq('suspension_confirmed', true);

  const { data: logs } = await q;
  const rows = logs || [];

  try {
    const html = generateWeatherReportHtml({ site, rows, thresholds: siteThresholds(site), from, to, filter });
    const pdfBuf = await rendererPool.render(html, {
      docTitle:   `Registro Meteo — ${site.name}`,
      rev:        1,
      footerLeft: 'D.Lgs. 36/2023 art. 107 · art. 1664 c.c.',
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="meteo_${siteId}_${Date.now()}.pdf"`);
    res.setHeader('Content-Length', pdfBuf.length);
    res.send(pdfBuf);
  } catch (err) {
    console.error('[weather-report.pdf]', err.message);
    res.status(500).json({ error: 'PDF_ERROR', message: err.message });
  }
});

module.exports = router;

