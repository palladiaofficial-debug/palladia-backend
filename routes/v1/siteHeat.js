'use strict';
/**
 * routes/v1/siteHeat.js
 *
 * Registro caldo cantiere — richiesta esplicita del titolare (2026-09-17),
 * base normativa D.L. 107/2026 art. 6 + messaggio INPS 2418/2026 (vedi
 * migrations/218 e services/heatArpalCron.js per i dettagli, incluso
 * perché NON è il "bollino rosso").
 *
 * Stesso identico pattern di conferma/dismiss/undo di routes/v1/
 * siteWeather.js (site_suspension_days condiviso — un giorno di caldo
 * confermato estende sites.end_date esattamente come un giorno di pioggia),
 * per coerenza: un titolare che già conosce il flusso meteo trova lo
 * stesso comportamento qui, non un secondo sistema da imparare.
 */
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { calcEndDate }       = require('../../lib/calcEndDate');
const { generateHeatReportHtml, generateHeatReportXlsx } = require('../../services/heatReport');
const { rendererPool }      = require('../../pdf-renderer');

async function getSiteOrFail(siteId, companyId, res) {
  const { data } = await supabase
    .from('sites')
    .select('id, name, address, client, start_date, end_date, contract_days, days_type, comune, latitude, longitude, heat_temp_threshold_c')
    .eq('id', siteId).eq('company_id', companyId).neq('status', 'eliminato').maybeSingle();
  if (!data) { res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' }); return null; }
  return data;
}

async function effectiveThreshold(site, companyId) {
  if (site.heat_temp_threshold_c != null) return Number(site.heat_temp_threshold_c);
  const { data: company } = await supabase.from('companies').select('heat_temp_threshold_c').eq('id', companyId).maybeSingle();
  return Number(company?.heat_temp_threshold_c ?? 35);
}

const LOG_COLS = 'id, log_date, temp_max_c, humidity_pct, solar_radiation_jcm2, wbgt_estimate_c, threshold_exceeded, threshold_reason, suspension_confirmed, suspension_dismissed, suspension_id, arpal_station_name, arpal_source_path, fetched_at';

// ── GET /api/v1/sites/:siteId/heat-log?from=&to= ──────────────────────────────
router.get('/sites/:siteId/heat-log', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { from, to } = req.query;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  let q = supabase.from('site_heat_logs').select(LOG_COLS).eq('site_id', siteId).order('log_date', { ascending: false });
  if (from) q = q.gte('log_date', from);
  if (to)   q = q.lte('log_date', to);
  const { data, error } = await q.limit(1100);
  if (error) return res.status(500).json({ error: 'DB_ERROR', message: error.message });

  res.json({ logs: data || [], threshold_c: await effectiveThreshold(site, req.companyId) });
});

// ── POST /api/v1/sites/:siteId/heat-log/:date/confirm ─────────────────────────
router.post('/sites/:siteId/heat-log/:date/confirm', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const { notes } = req.body || {};
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const { data: log } = await supabase.from('site_heat_logs')
    .select('id, temp_max_c, humidity_pct, wbgt_estimate_c, arpal_station_name')
    .eq('site_id', siteId).eq('log_date', date).maybeSingle();
  if (!log) return res.status(404).json({ error: 'LOG_NOT_FOUND' });

  const autoNotes = [
    log.temp_max_c != null ? `${log.temp_max_c}°C max` : null,
    log.humidity_pct != null ? `umidità ${log.humidity_pct}%` : null,
    log.wbgt_estimate_c != null ? `WBGT stimato ${log.wbgt_estimate_c}°C` : null,
    notes ? `— ${notes}` : null,
    `| Fonte: ARPAL${log.arpal_station_name ? ` (stazione ${log.arpal_station_name})` : ''}`,
  ].filter(Boolean).join(' · ');

  const { data: suspension, error: suspErr } = await supabase.from('site_suspension_days')
    .upsert({ company_id: req.companyId, site_id: siteId, day: date, reason: 'caldo', notes: autoNotes, created_by: req.user?.id ?? null },
      { onConflict: 'site_id,day' }).select('id').single();
  if (suspErr) return res.status(500).json({ error: 'DB_ERROR', message: suspErr.message });

  const { data: logUpdated, error: logUpdateErr } = await supabase.from('site_heat_logs')
    .update({ suspension_confirmed: true, suspension_id: suspension.id }).eq('id', log.id).select('id');
  if (logUpdateErr) return res.status(500).json({ error: 'DB_ERROR', message: logUpdateErr.message });
  if (!logUpdated?.length) return res.status(500).json({ error: 'DB_ERROR', message: 'Sospensione creata ma il log caldo non è stato aggiornato.' });

  const { data: suspRows } = await supabase.from('site_suspension_days').select('day').eq('site_id', siteId);
  const newEnd = calcEndDate(site.start_date, site.contract_days, site.days_type, (suspRows || []).map(r => r.day), site.comune ?? null);
  if (newEnd) {
    const { error: endDateErr } = await supabase.from('sites').update({ end_date: newEnd }).eq('id', siteId).eq('company_id', req.companyId);
    if (endDateErr) console.error(`[heatConfirm] ${siteId}: end_date non aggiornata:`, endDateErr.message);
  }

  const { data: pending } = await supabase.from('site_heat_logs').select('log_date')
    .eq('site_id', siteId).eq('threshold_exceeded', true).eq('suspension_confirmed', false).eq('suspension_dismissed', false);
  const pendingDays = (pending || []).map(r => r.log_date);
  if (pendingDays.length === 0) {
    await supabase.from('notifications').delete()
      .eq('company_id', req.companyId).eq('entity_type', 'site').eq('entity_id', siteId).eq('type', 'heat_suspension');
  }

  res.json({ ok: true, suspension, newEndDate: newEnd ?? null });
});

// ── POST /api/v1/sites/:siteId/heat-log/:date/dismiss ─────────────────────────
router.post('/sites/:siteId/heat-log/:date/dismiss', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const { data: updated, error: updateErr } = await supabase.from('site_heat_logs')
    .update({ suspension_dismissed: true }).eq('site_id', siteId).eq('log_date', date).select('id');
  if (updateErr) return res.status(500).json({ error: 'DB_ERROR', message: updateErr.message });
  if (!updated?.length) return res.status(404).json({ error: 'LOG_NOT_FOUND' });

  const { data: pending } = await supabase.from('site_heat_logs').select('log_date')
    .eq('site_id', siteId).eq('threshold_exceeded', true).eq('suspension_confirmed', false).eq('suspension_dismissed', false);
  if (!pending?.length) {
    await supabase.from('notifications').delete()
      .eq('company_id', req.companyId).eq('entity_type', 'site').eq('entity_id', siteId).eq('type', 'heat_suspension');
  }
  res.json({ ok: true });
});

// ── POST /api/v1/sites/:siteId/heat-log/:date/undo ────────────────────────────
router.post('/sites/:siteId/heat-log/:date/undo', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const { data: log } = await supabase.from('site_heat_logs')
    .select('id, suspension_id, suspension_confirmed, threshold_exceeded').eq('site_id', siteId).eq('log_date', date).maybeSingle();
  if (!log) return res.status(404).json({ error: 'LOG_NOT_FOUND' });
  if (!log.suspension_confirmed) return res.status(409).json({ error: 'NOT_CONFIRMED' });

  const suspensionDelete = log.suspension_id
    ? supabase.from('site_suspension_days').delete().eq('id', log.suspension_id).eq('site_id', siteId).eq('company_id', req.companyId)
    : supabase.from('site_suspension_days').delete().eq('site_id', siteId).eq('day', date).eq('company_id', req.companyId);
  const { error: suspDeleteErr } = await suspensionDelete;
  if (suspDeleteErr) return res.status(500).json({ error: 'DB_ERROR', message: suspDeleteErr.message });

  const { data: logReset, error: logResetErr } = await supabase.from('site_heat_logs')
    .update({ suspension_confirmed: false, suspension_dismissed: false, suspension_id: null }).eq('id', log.id).select('id');
  if (logResetErr) return res.status(500).json({ error: 'DB_ERROR', message: logResetErr.message });
  if (!logReset?.length) return res.status(500).json({ error: 'DB_ERROR', message: 'Sospensione rimossa ma il log caldo non è stato azzerato.' });

  const { data: suspRows } = await supabase.from('site_suspension_days').select('day').eq('site_id', siteId);
  const newEnd = calcEndDate(site.start_date, site.contract_days, site.days_type, (suspRows || []).map(r => r.day), site.comune ?? null);
  if (newEnd) {
    const { error: endDateErr } = await supabase.from('sites').update({ end_date: newEnd }).eq('id', siteId).eq('company_id', req.companyId);
    if (endDateErr) console.error(`[heatUndo] ${siteId}: end_date non aggiornata:`, endDateErr.message);
  }

  res.json({ ok: true, newEndDate: newEnd ?? null });
});

// ── GET /api/v1/sites/:siteId/heat-report.pdf ──────────────────────────────────
router.get('/sites/:siteId/heat-report.pdf', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { from, to, filter } = req.query;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  let q = supabase.from('site_heat_logs').select(LOG_COLS).eq('site_id', siteId).order('log_date', { ascending: true });
  if (from) q = q.gte('log_date', from);
  if (to)   q = q.lte('log_date', to);
  if (filter === 'critical')  q = q.eq('threshold_exceeded', true);
  if (filter === 'confirmed') q = q.eq('suspension_confirmed', true);
  const { data: logs } = await q;

  try {
    const html = generateHeatReportHtml({ site, rows: logs || [], thresholdC: await effectiveThreshold(site, req.companyId), from, to, filter });
    const pdfBuf = await rendererPool.render(html, {
      docTitle: `Relazione Tecnica Caldo — ${site.name}`, rev: 1,
      footerLeft: 'D.L. 107/2026 art. 6 · msg. INPS 2418/2026',
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="caldo_${siteId}_${Date.now()}.pdf"`);
    res.setHeader('Content-Length', pdfBuf.length);
    res.send(pdfBuf);
  } catch (err) {
    console.error('[heat-report.pdf]', err.message);
    res.status(500).json({ error: 'PDF_ERROR', message: err.message });
  }
});

// ── GET /api/v1/sites/:siteId/heat-report.xlsx ─────────────────────────────────
router.get('/sites/:siteId/heat-report.xlsx', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { from, to, filter } = req.query;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  let q = supabase.from('site_heat_logs').select(LOG_COLS).eq('site_id', siteId).order('log_date', { ascending: true });
  if (from) q = q.gte('log_date', from);
  if (to)   q = q.lte('log_date', to);
  if (filter === 'critical')  q = q.eq('threshold_exceeded', true);
  if (filter === 'confirmed') q = q.eq('suspension_confirmed', true);
  const { data: logs } = await q;

  const wb = generateHeatReportXlsx({ site, rows: logs || [], thresholdC: await effectiveThreshold(site, req.companyId), from, to, filter });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="caldo_${siteId}_${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

module.exports = router;
