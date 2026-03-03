'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { rendererPool }      = require('../../pdf-renderer');
const { buildDailyPresenceSummary, generatePresenceReportHtml } = require('../../services/presenceReport');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CSV_MAX_ROWS = 5000;

// GET /api/v1/reports/presence?siteId=&date= — CSV presenze (PRIVATO)
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
      id, event_type, timestamp_server, distance_m, method,
      worker:workers (id, full_name, fiscal_code)
    `)
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .gte('timestamp_server', `${date}T00:00:00.000Z`)
    .lte('timestamp_server', `${date}T23:59:59.999Z`)
    .order('timestamp_server', { ascending: true })
    .limit(CSV_MAX_ROWS);

  if (error) return res.status(500).json({ error: error.message });

  const rows = [
    'worker_id,full_name,fiscal_code,event_type,timestamp_server,distance_m,method',
    ...(data || []).map(r => [
      r.worker?.id          || '',
      `"${(r.worker?.full_name || '').replace(/"/g, '""')}"`,
      r.worker?.fiscal_code || '',
      r.event_type,
      r.timestamp_server,
      r.distance_m ?? '',
      r.method
    ].join(','))
  ].join('\r\n');

  const filename = `presenze-${date}-${siteId}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + rows);
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

module.exports = router;
