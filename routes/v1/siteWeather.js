'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt }              = require('../../middleware/verifyJwt');
const { getActualWeather, getWeatherRange, buildWeatherLogUpdate, groupRowsByShape } = require('../../services/weatherService');
const { calcEndDate }                    = require('../../lib/calcEndDate');
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

      const { data: row } = await supabase
        .from('site_weather_logs')
        .upsert({ company_id: req.companyId, site_id: siteId, log_date: d, ...update }, { onConflict: 'site_id,log_date' })
        .select()
        .single();

      results.push({ date: d, ok: true, data: row });
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

  if (!site.latitude || !site.longitude)
    return res.status(400).json({ error: 'NO_COORDS', message: 'Imposta le coordinate GPS del cantiere prima.' });
  if (!site.start_date)
    return res.status(400).json({ error: 'NO_START_DATE', message: 'Il cantiere non ha una data di inizio lavori.' });

  const TZ = 'Europe/Rome';
  const yesterday = (() => {
    const d = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: TZ }));
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();

  if (site.start_date > yesterday)
    return res.json({ inserted: 0, suspension_alerts: 0, message: 'Cantiere non ancora iniziato — nessuno storico disponibile.' });

  try {
    const weatherData = await getWeatherRange(site.latitude, site.longitude, site.start_date, yesterday);

    if (!weatherData.length)
      return res.json({ inserted: 0, suspension_alerts: 0 });

    // F-159 (AUDIT.md): un giorno già deciso da un umano (confermato/ignorato)
    // non deve vedersi cambiare il verdetto da un ri-backfill — vedi
    // buildWeatherLogUpdate.
    const { data: existingRows } = await supabase
      .from('site_weather_logs')
      .select('log_date, suspension_confirmed, suspension_dismissed, threshold_exceeded, precipitation_mm, wind_max_kmh, weather_code, data_source, era5_reconciled_at, precipitation_mm_original, wind_max_kmh_original, weather_code_original')
      .eq('site_id', siteId)
      .gte('log_date', site.start_date).lte('log_date', yesterday);
    const existingByDate = new Map((existingRows || []).map(r => [r.log_date, r]));

    const thresholds = siteThresholds(site);
    const rows = weatherData.map(w => ({
      company_id: req.companyId,
      site_id:    siteId,
      log_date:   w.date,
      ...buildWeatherLogUpdate(existingByDate.get(w.date), w, thresholds),
    }));

    // Upsert bulk — non sovrascrive suspension_confirmed/dismissed già esistenti.
    // F-200 (AUDIT.md): le righe non hanno tutte le stesse chiavi — un giorno
    // già DECISO da un umano omette threshold_exceeded/reason, e un giorno la
    // cui fonte in DB è più autorevole di quella appena ricevuta (es. ARPAL
    // già presente, backfill Open-Meteo più vecchio) viene ridotto dal
    // guard di precedenza in buildWeatherLogUpdate a solo fetched_at — un
    // upsert misto in un'unica chiamata scriverebbe NULL sulle colonne
    // mancanti per le righe che non le hanno (PostgREST usa l'unione delle
    // colonne del batch), cancellando dati già decisi/certificati.
    for (const batch of groupRowsByShape(rows)) {
      const { error: upsertErr } = await supabase
        .from('site_weather_logs')
        .upsert(batch, { onConflict: 'site_id,log_date', ignoreDuplicates: false });
      if (upsertErr) return res.status(500).json({ error: 'DB_ERROR', message: upsertErr.message });
    }

    const suspDays = rows.filter(r => r.threshold_exceeded).length;
    res.json({ inserted: rows.length, suspension_alerts: suspDays });

  } catch (err) {
    console.error('[weatherBackfill]', err.message);
    res.status(502).json({ error: 'WEATHER_API_ERROR', message: err.message });
  }
});

// ── POST /api/v1/sites/:siteId/weather-log/:date/confirm ─────────────────────
// Conferma sospensione: crea il giorno in site_suspension_days + aggiorna log.
router.post('/sites/:siteId/weather-log/:date/confirm', verifySupabaseJwt, validate(confirmSuspensionSchema), async (req, res) => {
  const { siteId, date } = req.params;
  const { notes }        = req.body || {};

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  // Recupera il log meteo
  const { data: log } = await supabase
    .from('site_weather_logs')
    .select('id, threshold_reason, precipitation_mm, wind_max_kmh, weather_desc, data_source, arpal_station_name')
    .eq('site_id', siteId)
    .eq('log_date', date)
    .maybeSingle();

  if (!log) return res.status(404).json({ error: 'LOG_NOT_FOUND' });

  // F-199 (AUDIT.md): "Fonte: Open-Meteo / ERA5" era scritto anche quando
  // il dato era già certificato ARPAL — il titolare l'ha segnalato
  // esplicitamente sulla stessa distinzione nell'interfaccia ("dovrebbe
  // esserci scritto solo ARPAL, è così che guadagniamo la fiducia di
  // tutti"). Questa nota finisce in site_suspension_days.notes, un
  // documento legale — deve riflettere la fonte reale del giorno.
  const fonteLabel = log.data_source === 'arpal_certified'
    ? `ARPAL${log.arpal_station_name ? ` (stazione ${log.arpal_station_name})` : ''}`
    : log.data_source === 'era5_confirmed' ? 'ERA5 (Open-Meteo)' : 'stima Open-Meteo, in attesa di certificazione ARPAL';

  // Costruisce note automatiche con i dati meteo
  const autoNotes = [
    log.weather_desc,
    log.precipitation_mm > 0 ? `${log.precipitation_mm}mm pioggia` : null,
    log.wind_max_kmh > 0    ? `vento ${log.wind_max_kmh}km/h max` : null,
    notes ? `— ${notes}` : null,
    `| Fonte: ${fonteLabel}`,
  ].filter(Boolean).join(' · ');

  // Crea il giorno di sospensione
  const { data: suspension, error: suspErr } = await supabase
    .from('site_suspension_days')
    .upsert({
      company_id: req.companyId,
      site_id:    siteId,
      day:        date,
      reason:     log.threshold_reason || 'pioggia',
      notes:      autoNotes,
      created_by: req.user?.id ?? null,
    }, { onConflict: 'site_id,day' })
    .select('id')
    .single();

  if (suspErr) return res.status(500).json({ error: 'DB_ERROR', message: suspErr.message });

  // Aggiorna il log con il link alla sospensione
  await supabase
    .from('site_weather_logs')
    .update({ suspension_confirmed: true, suspension_id: suspension.id })
    .eq('id', log.id);

  // Ricalcola end_date del cantiere
  const { data: suspRows } = await supabase
    .from('site_suspension_days').select('day').eq('site_id', siteId);
  const newEnd = calcEndDate(site.start_date, site.contract_days, site.days_type, (suspRows||[]).map(r=>r.day), site.comune ?? null);
  if (newEnd) await supabase.from('sites').update({ end_date: newEnd }).eq('id', siteId).eq('company_id', req.companyId);

  // Aggiorna notifica (rimuovi questo giorno dal conteggio pendenti)
  const { data: pending } = await supabase
    .from('site_weather_logs').select('log_date')
    .eq('site_id', siteId).eq('threshold_exceeded', true)
    .eq('suspension_confirmed', false).eq('suspension_dismissed', false);

  const pendingDays = (pending || []).map(r => r.log_date);
  if (pendingDays.length === 0) {
    await supabase.from('notifications').delete()
      .eq('company_id', req.companyId).eq('entity_type', 'site')
      .eq('entity_id', siteId).eq('type', 'weather_suspension');
  } else {
    const listIt = pendingDays.sort().map(d => new Date(d+'T00:00:00').toLocaleDateString('it-IT',{day:'numeric',month:'long'}));
    await supabase.from('notifications').upsert({
      company_id: req.companyId, type: 'weather_suspension', severity: 'warning',
      title: `Meteo — ${pendingDays.length} ${pendingDays.length===1?'giornata':'giornate'} da confermare`,
      body: `${site.name}\n${listIt.join(' · ')}`,
      entity_type: 'site', entity_id: siteId, updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,entity_type,entity_id,type' });
  }

  res.json({ ok: true, suspension, newEndDate: newEnd ?? null });
});

// ── POST /api/v1/sites/:siteId/weather-log/:date/dismiss ─────────────────────
router.post('/sites/:siteId/weather-log/:date/dismiss', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  await supabase
    .from('site_weather_logs')
    .update({ suspension_dismissed: true })
    .eq('site_id', siteId).eq('log_date', date);

  const { data: pending } = await supabase
    .from('site_weather_logs').select('log_date')
    .eq('site_id', siteId).eq('threshold_exceeded', true)
    .eq('suspension_confirmed', false).eq('suspension_dismissed', false);

  if (!pending?.length) {
    await supabase.from('notifications').delete()
      .eq('company_id', req.companyId).eq('entity_type', 'site')
      .eq('entity_id', siteId).eq('type', 'weather_suspension');
  }

  res.json({ ok: true });
});

// ── POST /api/v1/sites/:siteId/weather-log/:date/undo ────────────────────────
// Annulla una sospensione confermata per errore.
// Elimina da site_suspension_days, azzera i flag sul log, ricalcola end_date.
router.post('/sites/:siteId/weather-log/:date/undo', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  // Recupera il log per avere suspension_id
  const { data: log } = await supabase
    .from('site_weather_logs')
    .select('id, suspension_id, suspension_confirmed, threshold_exceeded')
    .eq('site_id',  siteId)
    .eq('log_date', date)
    .maybeSingle();

  if (!log) return res.status(404).json({ error: 'LOG_NOT_FOUND' });
  if (!log.suspension_confirmed) return res.status(409).json({ error: 'NOT_CONFIRMED' });

  // Elimina il record da site_suspension_days
  if (log.suspension_id) {
    await supabase
      .from('site_suspension_days')
      .delete()
      .eq('id',         log.suspension_id)
      .eq('site_id',    siteId)
      .eq('company_id', req.companyId);
  } else {
    // Fallback: elimina per site_id + day nel caso suspension_id non sia stato salvato
    await supabase
      .from('site_suspension_days')
      .delete()
      .eq('site_id',    siteId)
      .eq('day',        date)
      .eq('company_id', req.companyId);
  }

  // Azzera i flag sul log meteo — il giorno torna nello stato "pendente"
  await supabase
    .from('site_weather_logs')
    .update({ suspension_confirmed: false, suspension_dismissed: false, suspension_id: null })
    .eq('id', log.id);

  // Ricalcola end_date del cantiere
  const { data: suspRows } = await supabase
    .from('site_suspension_days').select('day').eq('site_id', siteId);
  const newEnd = calcEndDate(
    site.start_date, site.contract_days, site.days_type,
    (suspRows || []).map(r => r.day), site.comune ?? null,
  );
  if (newEnd) await supabase.from('sites').update({ end_date: newEnd }).eq('id', siteId).eq('company_id', req.companyId);

  // Aggiorna notifiche: questo giorno è di nuovo pendente se threshold_exceeded
  if (log.threshold_exceeded) {
    const { data: pending } = await supabase
      .from('site_weather_logs').select('log_date')
      .eq('site_id', siteId).eq('threshold_exceeded', true)
      .eq('suspension_confirmed', false).eq('suspension_dismissed', false);
    const pendingDays = (pending || []).map(r => r.log_date);
    const listIt = pendingDays.sort().map(d => new Date(d + 'T00:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long' }));
    await supabase.from('notifications').upsert({
      company_id: req.companyId, type: 'weather_suspension', severity: 'warning',
      title: `Meteo — ${pendingDays.length} ${pendingDays.length === 1 ? 'giornata' : 'giornate'} da confermare`,
      body: `${site.name}\n${listIt.join(' · ')}`,
      entity_type: 'site', entity_id: siteId, updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,entity_type,entity_id,type' });
  }

  res.json({ ok: true, newEndDate: newEnd ?? null });
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

