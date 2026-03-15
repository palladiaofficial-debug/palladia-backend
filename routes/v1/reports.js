'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { rendererPool }      = require('../../pdf-renderer');
const { buildDailyPresenceSummary, generatePresenceReportHtml } = require('../../services/presenceReport');
const { buildWorkerHoursReport, generateWorkerHoursPdfHtml, generateWorkerHoursXlsx } = require('../../services/workerHoursReport');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/v1/reports/presence?siteId=&date= — CSV singola giornata (PRIVATO)
// Retrocompatibile: accetta ancora il parametro 'date' per singolo giorno.
// BOM UTF-8 incluso per apertura corretta in Excel (Windows)
router.get('/reports/presence', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.query;
  if (!siteId || !date) {
    return res.status(400).json({ error: 'siteId e date obbligatori (YYYY-MM-DD)' });
  }
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ error: 'date deve essere YYYY-MM-DD' });
  }

  const { data, error } = await supabase
    .from('presence_logs')
    .select(`
      id, event_type, timestamp_server, distance_m, gps_accuracy_m, method,
      worker:workers (id, full_name, fiscal_code)
    `)
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .gte('timestamp_server', `${date}T00:00:00.000Z`)
    .lte('timestamp_server', `${date}T23:59:59.999Z`)
    .order('timestamp_server', { ascending: true })
    .limit(20000);

  if (error) return res.status(500).json({ error: error.message });

  const rows = [
    'worker_id,full_name,fiscal_code,event_type,timestamp_server,distance_m,gps_accuracy_m,method',
    ...(data || []).map(r => [
      r.worker?.id           || '',
      `"${(r.worker?.full_name || '').replace(/"/g, '""')}"`,
      r.worker?.fiscal_code  || '',
      r.event_type,
      r.timestamp_server,
      r.distance_m      ?? '',
      r.gps_accuracy_m  ?? '',
      r.method
    ].join(','))
  ].join('\r\n');

  const filename = `presenze-${date}-${siteId}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + rows);
});

// GET /api/v1/reports/presence-range?siteId=&from=&to= — CSV range date (PRIVATO)
// Export annuale illimitato per periodo: nessun limite 90 giorni, fino a 200k righe raw.
// I dati sono già riepilogati per coppia ENTRY/EXIT come nel PDF.
// Formato: una riga per lavoratore per giorno con prima entrata / ultima uscita / ore totali.
router.get('/reports/presence-range', verifySupabaseJwt, async (req, res) => {
  const { siteId, from, to } = req.query;
  if (!siteId || !from || !to) {
    return res.status(400).json({ error: 'siteId, from e to obbligatori (YYYY-MM-DD)' });
  }
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return res.status(400).json({ error: 'from e to devono essere YYYY-MM-DD' });
  }
  if (from > to) {
    return res.status(400).json({ error: 'from deve essere <= to' });
  }

  // Nessun limite di giorni: l'export annuale è il caso d'uso principale.
  // Limit righe raw: 200k (sufficiente per ~500 lavoratori × 365 giorni × 1 coppia)
  const { data: logs, error: logsErr } = await supabase
    .from('presence_logs')
    .select(`
      worker_id, event_type, timestamp_server, distance_m, gps_accuracy_m, site_id,
      worker:workers (id, full_name, fiscal_code),
      site:sites (id, name, address)
    `)
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .gte('timestamp_server', `${from}T00:00:00.000Z`)
    .lte('timestamp_server', `${to}T23:59:59.999Z`)
    .order('worker_id',         { ascending: true })
    .order('timestamp_server',  { ascending: true })
    .limit(200000);

  if (logsErr) return res.status(500).json({ error: logsErr.message });

  const limitReached = (logs || []).length === 200000;

  // Raggruppa per worker → giorno (timezone Europe/Rome)
  const byWorkerDay = new Map();
  for (const log of (logs || [])) {
    if (!log.worker) continue;
    const dateKey = new Date(log.timestamp_server).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
    const mapKey  = `${log.worker_id}::${dateKey}`;
    if (!byWorkerDay.has(mapKey)) {
      byWorkerDay.set(mapKey, { worker: log.worker, dateKey, logs: [] });
    }
    byWorkerDay.get(mapKey).logs.push(log);
  }

  // Costruisci righe CSV — una per worker per giorno
  const csvRows = [
    'data,lavoratore,codice_fiscale,prima_entrata,ultima_uscita,ore_totali,n_ingressi,distanza_media_m,gps_media_m,anomalie'
  ];

  const fmtTime = ts => new Date(ts).toLocaleTimeString('it-IT', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome'
  });

  const sortedKeys = Array.from(byWorkerDay.keys()).sort((a, b) => {
    const [, dayA] = a.split('::'); const [, dayB] = b.split('::');
    if (dayA !== dayB) return dayA.localeCompare(dayB);
    return byWorkerDay.get(a).worker.full_name.localeCompare(byWorkerDay.get(b).worker.full_name);
  });

  for (const key of sortedKeys) {
    const { worker, dateKey, logs: dayLogs } = byWorkerDay.get(key);

    // Pairing sequenziale ENTRY/EXIT
    const anomalies = [];
    let hoursTotal = 0;
    let intervals  = 0;
    let i = 0;
    while (i < dayLogs.length) {
      const l = dayLogs[i];
      if (l.event_type === 'ENTRY') {
        const next = i + 1 < dayLogs.length ? dayLogs[i + 1] : null;
        if (next && next.event_type === 'EXIT') {
          hoursTotal += Math.max(0, (new Date(next.timestamp_server) - new Date(l.timestamp_server)) / 3_600_000);
          intervals++;
          i += 2;
        } else {
          anomalies.push('Uscita mancante');
          i += 1;
        }
      } else {
        anomalies.push('Uscita senza entrata');
        i += 1;
      }
    }

    const entryLogs = dayLogs.filter(l => l.event_type === 'ENTRY');
    const exitLogs  = dayLogs.filter(l => l.event_type === 'EXIT');
    const firstEntry = entryLogs.length > 0 ? fmtTime(entryLogs[0].timestamp_server) : '';
    const lastExit   = exitLogs.length  > 0 ? fmtTime(exitLogs[exitLogs.length - 1].timestamp_server) : '';

    const dists = dayLogs.map(l => l.distance_m).filter(v => v != null);
    const accs  = dayLogs.map(l => l.gps_accuracy_m).filter(v => v != null);
    const avgDist = dists.length > 0 ? Math.round(dists.reduce((a, b) => a + b, 0) / dists.length) : '';
    const avgAcc  = accs.length  > 0 ? Math.round(accs.reduce((a, b) => a + b, 0)  / accs.length)  : '';

    csvRows.push([
      dateKey,
      `"${worker.full_name.replace(/"/g, '""')}"`,
      worker.fiscal_code,
      firstEntry,
      lastExit,
      hoursTotal > 0 ? hoursTotal.toFixed(2) : '',
      intervals,
      avgDist,
      avgAcc,
      `"${anomalies.join('; ').replace(/"/g, '""')}"`
    ].join(','));
  }

  // Header con metadati se il limite è stato raggiunto
  if (limitReached) {
    csvRows.unshift(`# ATTENZIONE: dati troncati a 200.000 righe raw — export parziale`);
  }

  const filename = `presenze-range-${from}-${to}-${siteId}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (limitReached) res.setHeader('X-Palladia-Truncated', 'true');
  res.send('\uFEFF' + csvRows.join('\r\n'));
});

// ── GET /api/v1/reports/sites/:id/presenze?from=YYYY-MM-DD&to=YYYY-MM-DD ─────
// Genera PDF "Registro Presenze Cantiere" — stile identico al POS PalladIA.
// Protetto: JWT + company membership (verifySupabaseJwt popola req.companyId).
// Il company_id è derivato SEMPRE dal JWT, mai dal client → sicurezza multi-tenant.
router.get('/reports/sites/:id/presenze', verifySupabaseJwt, async (req, res) => {
  const siteId = req.params.id;
  const { from, to } = req.query;

  // 1. Validazione parametri
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to || !dateRe.test(from) || !dateRe.test(to)) {
    return res.status(400).json({
      error:   'INVALID_PARAMS',
      message: 'from e to obbligatori (YYYY-MM-DD)'
    });
  }
  if (from > to) {
    return res.status(400).json({
      error:   'INVALID_RANGE',
      message: 'from deve essere <= to'
    });
  }
  // Limite anti-abuso: max 90 giorni per richiesta
  const daysDiff = (new Date(to) - new Date(from)) / 86_400_000;
  if (daysDiff > 90) {
    return res.status(400).json({
      error:   'RANGE_TOO_LARGE',
      message: 'Intervallo massimo 90 giorni per richiesta'
    });
  }

  // 2. Build dati (fetch + elaborazione)
  let reportData;
  try {
    reportData = await buildDailyPresenceSummary(siteId, req.companyId, from, to);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
    console.error('[presenze-pdf] data error:', err.message);
    return res.status(500).json({ error: 'DATA_ERROR', detail: err.message });
  }

  // 3. Genera HTML
  const html = generatePresenceReportHtml(reportData);

  // 4. Render PDF (Puppeteer — stesso pool del POS)
  let pdfBuffer;
  try {
    pdfBuffer = await rendererPool.render(html, {
      docTitle: `Registro Presenze — ${reportData.site.name}`,
      rev:      1
    });
  } catch (renderErr) {
    console.error('[presenze-pdf] render error:', renderErr.message);
    return res.status(500).json({ error: 'PDF_RENDER_ERROR' });
  }

  // 5. Risposta
  const filename = `presenze-${siteId}-${from}-${to}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
});

// ── GET /api/v1/worksites/:id/presence-report — alias pubblico ────────────────
// ?format=pdf|csv  ?from=YYYY-MM-DD  ?to=YYYY-MM-DD
// Alias semantico di /reports/sites/:id/presenze (pdf) e /reports/presence-range (csv).
// Stesso middleware JWT + company ownership.
router.get('/worksites/:id/presence-report', verifySupabaseJwt, async (req, res) => {
  const siteId = req.params.id;
  const { format = 'pdf', from, to } = req.query;

  if (!['pdf', 'csv'].includes(format)) {
    return res.status(400).json({ error: 'format deve essere pdf o csv' });
  }
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return res.status(400).json({ error: 'from e to obbligatori (YYYY-MM-DD)' });
  }
  if (from > to) {
    return res.status(400).json({ error: 'from deve essere <= to' });
  }

  // Forward to the right sub-handler by rewriting the URL params
  req.params.id = siteId;
  req.query.siteId = siteId;

  if (format === 'csv') {
    // Delegate to presence-range logic (inline — avoids double-auth)
    const daysDiff = (new Date(to) - new Date(from)) / 86_400_000;
    if (daysDiff > 365) {
      return res.status(400).json({ error: 'Intervallo massimo 365 giorni per CSV' });
    }
    const { data: logs, error: logsErr } = await supabase
      .from('presence_logs')
      .select(`
        worker_id, event_type, timestamp_server, distance_m, gps_accuracy_m,
        worker:workers (id, full_name, fiscal_code)
      `)
      .eq('site_id', siteId)
      .eq('company_id', req.companyId)
      .gte('timestamp_server', `${from}T00:00:00.000Z`)
      .lte('timestamp_server', `${to}T23:59:59.999Z`)
      .order('worker_id',        { ascending: true })
      .order('timestamp_server', { ascending: true })
      .limit(200000);

    if (logsErr) return res.status(500).json({ error: logsErr.message });

    const rows = [
      'data,lavoratore,codice_fiscale,evento,timestamp,distanza_m,gps_accuracy_m',
      ...(logs || []).filter(r => r.worker).map(r => [
        new Date(r.timestamp_server).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }),
        `"${(r.worker.full_name || '').replace(/"/g, '""')}"`,
        r.worker.fiscal_code || '',
        r.event_type,
        r.timestamp_server,
        r.distance_m     ?? '',
        r.gps_accuracy_m ?? ''
      ].join(','))
    ].join('\r\n');

    const filename = `presenze-${siteId}-${from}-${to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send('\uFEFF' + rows);
  }

  // format === 'pdf'
  const daysDiff = (new Date(to) - new Date(from)) / 86_400_000;
  if (daysDiff > 90) {
    return res.status(400).json({ error: 'Intervallo massimo 90 giorni per PDF' });
  }

  let reportData;
  try {
    reportData = await buildDailyPresenceSummary(siteId, req.companyId, from, to);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
    return res.status(500).json({ error: 'DATA_ERROR', detail: err.message });
  }

  const html = generatePresenceReportHtml(reportData);
  let pdfBuffer;
  try {
    pdfBuffer = await rendererPool.render(html, {
      docTitle: `Registro Presenze — ${reportData.site.name}`,
      rev: 1
    });
  } catch (renderErr) {
    return res.status(500).json({ error: 'PDF_RENDER_ERROR' });
  }

  const filename = `presenze-${siteId}-${from}-${to}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
});

// ── Worker Hours Report endpoints ─────────────────────────────────────────────
// Parametri comuni: siteId (uuid), from (YYYY-MM-DD), to (YYYY-MM-DD), workerId? (uuid)
// Max range: 366 giorni (export annuale)

function validateHoursParams(req, res) {
  const { siteId, from, to } = req.query;
  if (!siteId || !from || !to) {
    res.status(400).json({ error: 'siteId, from e to obbligatori (YYYY-MM-DD)' });
    return null;
  }
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    res.status(400).json({ error: 'from e to devono essere YYYY-MM-DD' });
    return null;
  }
  if (from > to) {
    res.status(400).json({ error: 'from deve essere <= to' });
    return null;
  }
  const daysDiff = (new Date(to) - new Date(from)) / 86_400_000;
  if (daysDiff > 366) {
    res.status(400).json({ error: 'Intervallo massimo 366 giorni' });
    return null;
  }
  return { siteId, from, to, workerId: req.query.workerId || null };
}

// GET /api/v1/reports/worker-hours → JSON dati strutturati
router.get('/reports/worker-hours', verifySupabaseJwt, async (req, res) => {
  const params = validateHoursParams(req, res);
  if (!params) return;

  try {
    const data = await buildWorkerHoursReport(params.siteId, req.companyId, params.from, params.to, params.workerId);
    res.json(data);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
    console.error('[worker-hours] data error:', err.message);
    res.status(500).json({ error: 'DATA_ERROR', detail: err.message });
  }
});

// GET /api/v1/reports/worker-hours-pdf → PDF professionale (Puppeteer)
router.get('/reports/worker-hours-pdf', verifySupabaseJwt, async (req, res) => {
  const params = validateHoursParams(req, res);
  if (!params) return;

  let data;
  try {
    data = await buildWorkerHoursReport(params.siteId, req.companyId, params.from, params.to, params.workerId);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
    console.error('[worker-hours-pdf] data error:', err.message);
    return res.status(500).json({ error: 'DATA_ERROR', detail: err.message });
  }

  const html = generateWorkerHoursPdfHtml(data);

  let pdfBuffer;
  try {
    pdfBuffer = await rendererPool.render(html, {
      docTitle: `Report Ore — ${data.site.name}`,
      rev:      1,
    });
  } catch (renderErr) {
    console.error('[worker-hours-pdf] render error:', renderErr.message);
    return res.status(500).json({ error: 'PDF_RENDER_ERROR' });
  }

  const filename = `ore-lavorate-${params.siteId}-${params.from}-${params.to}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
});

// GET /api/v1/reports/worker-hours-xlsx → Excel (.xlsx) — 3 fogli
router.get('/reports/worker-hours-xlsx', verifySupabaseJwt, async (req, res) => {
  const params = validateHoursParams(req, res);
  if (!params) return;

  let data;
  try {
    data = await buildWorkerHoursReport(params.siteId, req.companyId, params.from, params.to, params.workerId);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
    console.error('[worker-hours-xlsx] data error:', err.message);
    return res.status(500).json({ error: 'DATA_ERROR', detail: err.message });
  }

  let xlsxBuffer;
  try {
    xlsxBuffer = generateWorkerHoursXlsx(data);
  } catch (xlsxErr) {
    console.error('[worker-hours-xlsx] xlsx error:', xlsxErr.message);
    return res.status(500).json({ error: 'XLSX_ERROR' });
  }

  const filename = `ore-lavorate-${params.siteId}-${params.from}-${params.to}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', xlsxBuffer.length);
  res.send(xlsxBuffer);
});

module.exports = router;
