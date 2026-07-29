'use strict';
/**
 * routes/v1/valueMetrics.js
 * Layer "proof of value" — widget dashboard impresa.
 *
 * GET /api/v1/value-metrics                 — numeri precalcolati (letti da
 *                                              value_metrics, MAI ricalcolati
 *                                              a request — vedi services/valueMetrics.js
 *                                              + cron giornaliero dailyStatsCron.js)
 * GET /api/v1/value-metrics/detail/:metric   — elenco esatto degli eventi dietro
 *                                              un numero (click-through), calcolato
 *                                              live: sempre aggiornato, sempre
 *                                              coerente con la stessa logica usata
 *                                              per l'aggregato.
 */
const router   = require('express').Router();
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const supabase = require('../../lib/supabase');
const { renderHtmlToPdf } = require('../../pdf-renderer');
const {
  computeScadenzeESanzioni, computeDocumentiGenerati, computeOrePresenza,
} = require('../../services/valueMetrics');
const { buildMonthlyReportData } = require('../../services/monthlyValueReport');

router.get('/value-metrics', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('value_metrics')
    .select('scadenze_intercettate, sanzioni_evitate_cents, documenti_generati, ore_presenza_tracciate, has_data, computed_at')
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  if (!data || !data.has_data) {
    return res.json({ has_data: false });
  }

  res.json({
    has_data: true,
    scadenze_intercettate:  data.scadenze_intercettate,
    sanzioni_evitate_cents: data.sanzioni_evitate_cents,
    documenti_generati:     data.documenti_generati,
    ore_presenza_tracciate: data.ore_presenza_tracciate,
    computed_at:            data.computed_at,
  });
});

router.get('/value-metrics/detail/:metric', verifySupabaseJwt, async (req, res) => {
  const { metric } = req.params;

  try {
    if (metric === 'scadenze' || metric === 'sanzioni') {
      const { count, sanzioniCents, items } = await computeScadenzeESanzioni(req.companyId);
      return res.json({
        metric, count, sanzioni_evitate_cents: sanzioniCents,
        items: items.map(i => ({
          entity_type:      i.entity_type,
          entity_id:         i.entity_id,
          label:             i.label,
          notified_at:       i.notified_at,
          resolved_at:       i.resolved_at,
          violation_label:   i.violation_label || null,
          amount_min_cents:  i.amount_min_cents || null,
          legal_reference:   i.legal_reference || null,
        })),
      });
    }
    if (metric === 'documenti') {
      const { count, items } = await computeDocumentiGenerati(req.companyId);
      return res.json({ metric, count, items });
    }
    if (metric === 'presenze') {
      const { totalHours, totalShifts, items } = await computeOrePresenza(req.companyId);
      return res.json({ metric, total_hours: totalHours, total_shifts: totalShifts, items });
    }
    return res.status(400).json({ error: 'INVALID_METRIC' });
  } catch (e) {
    res.status(500).json({ error: 'COMPUTE_ERROR', detail: e.message });
  }
});

// ── PDF "Il tuo mese con Palladia" (on-demand, stampabile) ────────────────────
function esc(s) {
  if (s == null) return '—';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtEuro(cents) { return `€${Math.round((cents || 0) / 100).toLocaleString('it-IT')}`; }
function fmtDate(d) { return new Date(d).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' }); }

const SEMAFORO_COLOR = { verde: '#10b981', giallo: '#f59e0b', rosso: '#ef4444' };
const SEMAFORO_LABEL = { verde: 'Conforme', giallo: 'Attenzione', rosso: 'Non conforme' };

function buildMonthlyReportHtml(data) {
  const { companyName, monthLabel, semaforo, delta, stats, upcoming } = data;
  const semColor = SEMAFORO_COLOR[semaforo.semaforo] || '#9ca3af';
  const trendLine = delta.available
    ? (delta.trend === 'migliorato' ? `Migliorato rispetto al mese scorso (era ${esc(SEMAFORO_LABEL[delta.previous])})`
      : delta.trend === 'peggiorato' ? `Peggiorato rispetto al mese scorso (era ${esc(SEMAFORO_LABEL[delta.previous])})`
      : 'Stabile rispetto al mese scorso')
    : 'Primo mese di tracciamento';

  const upcomingRows = (upcoming || []).map(u => `
    <tr><td>${esc(u.label)}</td><td class="num">${fmtDate(u.expiry_date)}</td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 26mm 0 24mm 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10.5px; color: #1a1a1a; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .doc { padding: 0 16mm; }
  .report-header { background: #0a0a0a; color: #fff; padding: 13px 16mm 14px; margin: 0 -16mm 14px; border-top: 2px solid #fff; page-break-after: avoid; }
  .report-brand { font-size: 7.5px; font-weight: 700; letter-spacing: 2.2px; color: #777; text-transform: uppercase; margin-bottom: 7px; }
  .report-title { font-size: 17px; font-weight: 700; color: #fff; letter-spacing: -0.2px; line-height: 1.2; margin-bottom: 4px; text-transform: capitalize; }
  .report-subtitle { font-size: 10.5px; color: #999; }
  .semaforo-box { display: flex; align-items: center; gap: 10px; background: #f7f7f7; border-left: 2.5px solid ${semColor}; border-radius: 0 4px 4px 0; padding: 10px 12px; margin-bottom: 14px; page-break-inside: avoid; }
  .semaforo-dot { width: 10px; height: 10px; border-radius: 50%; background: ${semColor}; flex-shrink: 0; }
  .semaforo-label { font-size: 12px; font-weight: 700; color: #000; }
  .semaforo-trend { font-size: 10px; color: #666; margin-top: 1px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; page-break-inside: avoid; }
  .kpi-card { background: #fafafa; border-top: 2px solid #0a0a0a; padding: 7px 10px 8px; }
  .kpi-value { font-size: 18px; font-weight: 700; color: #000; line-height: 1.15; letter-spacing: -0.3px; font-variant-numeric: tabular-nums; margin-bottom: 3px; }
  .kpi-label { font-size: 8.5px; color: #888; line-height: 1.25; text-transform: uppercase; letter-spacing: 0.2px; }
  .section-title { font-size: 10px; font-weight: 700; color: #000; letter-spacing: 0.6px; text-transform: uppercase; padding-bottom: 3px; border-bottom: 1.5px solid #000; margin-bottom: 7px; page-break-after: avoid; }
  table.upcoming { width: 100%; border-collapse: collapse; font-size: 9.5px; }
  table.upcoming td { padding: 5px 0; border-bottom: 1px solid #efefef; color: #2a2a2a; }
  table.upcoming td.num { text-align: right; color: #888; white-space: nowrap; padding-left: 12px; }
  .empty-note { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 10px 14px; font-size: 10.5px; color: #16a34a; font-weight: 600; }
  .doc-footer { font-size: 8.5px; color: #ccc; text-align: center; margin-top: 20px; padding-top: 8px; border-top: 1px solid #f0f0f0; }
</style>
</head>
<body>
<div class="doc">

  <div class="report-header">
    <div class="report-brand">Palladia &middot; Il tuo mese</div>
    <div class="report-title">${esc(monthLabel)}</div>
    <div class="report-subtitle">${esc(companyName)}</div>
  </div>

  <div class="semaforo-box">
    <div class="semaforo-dot"></div>
    <div>
      <div class="semaforo-label">${esc(SEMAFORO_LABEL[semaforo.semaforo] || semaforo.semaforo)}</div>
      <div class="semaforo-trend">${esc(trendLine)}</div>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi-card"><div class="kpi-value">${stats.oreNelMese.toLocaleString('it-IT')}</div><div class="kpi-label">Ore di presenza</div></div>
    <div class="kpi-card"><div class="kpi-value">${stats.documentiNelMese}</div><div class="kpi-label">Documenti generati</div></div>
    <div class="kpi-card"><div class="kpi-value">${stats.scadenzeNelMese}</div><div class="kpi-label">Scadenze gestite</div></div>
    <div class="kpi-card"><div class="kpi-value">${stats.sanzioniNelMeseCents > 0 ? fmtEuro(stats.sanzioniNelMeseCents) : '—'}</div><div class="kpi-label">Sanzioni evitate</div></div>
  </div>

  <div class="section-title">Il mese prossimo</div>
  ${upcoming && upcoming.length
    ? `<table class="upcoming">${upcomingRows}</table>`
    : `<div class="empty-note">Nessuna scadenza nei prossimi 30 giorni.</div>`}

  <div class="doc-footer">Generato da Palladia &middot; Report basato su dati verificabili, non stime</div>
</div>
</body>
</html>`;
}

router.get('/value-metrics/monthly-report.pdf', verifySupabaseJwt, async (req, res) => {
  try {
    const data = await buildMonthlyReportData(req.companyId);
    const html = buildMonthlyReportHtml(data);
    const pdf  = await renderHtmlToPdf(html, {
      docTitle:   'Il tuo mese con Palladia',
      footerLeft: 'Report mensile — dati verificabili',
    });
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="palladia-report-mensile-${Date.now()}.pdf"`,
      'Cache-Control':       'no-store',
    });
    return res.send(pdf);
  } catch (err) {
    console.error('[value-metrics/monthly-report.pdf] error:', err.message);
    res.status(500).json({ error: 'EXPORT_ERROR', detail: err.message });
  }
});

// ── Ricevuta "scadenza intercettata" (on-demand, un singolo evento) ───────────
// Artefatto di chiusura per il flusso "gestione scadenza" — oggi una notifica
// risolta spariva in silenzio (pruneNotifications cancella la riga, vedi
// migrazione 141), senza mai un momento tangibile "hai evitato questo".
function buildReceiptHtml(item, companyName) {
  const hasSanction = !!item.violation_label;
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: A4; margin: 26mm 0 24mm 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #1a1a1a; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .doc { padding: 0 16mm; }
  .header { background: #0a0a0a; color: #fff; padding: 13px 16mm 14px; margin: 0 -16mm 20px; border-top: 2px solid #fff; }
  .brand { font-size: 7.5px; font-weight: 700; letter-spacing: 2.2px; color: #777; text-transform: uppercase; margin-bottom: 7px; }
  .title { font-size: 17px; font-weight: 700; color: #fff; letter-spacing: -0.2px; }
  .company { font-size: 10.5px; color: #999; margin-top: 4px; }
  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #efefef; }
  .row .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.3px; color: #888; }
  .row .value { font-size: 12px; font-weight: 600; color: #1a1a1a; text-align: right; max-width: 60%; }
  .sanction-box { margin-top: 24px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px 18px; }
  .sanction-amount { font-size: 22px; font-weight: 800; color: #16a34a; }
  .sanction-label { font-size: 11px; color: #166534; margin-top: 4px; }
  .sanction-ref { font-size: 9.5px; color: #4d7c5f; margin-top: 6px; }
  .review-note { font-size: 8.5px; color: #92702a; background: #fef9e7; border: 1px solid #fde68a; border-radius: 6px; padding: 6px 10px; margin-top: 10px; }
  .ok-box { margin-top: 24px; background: #f7f7f7; border-left: 2.5px solid #10b981; border-radius: 0 4px 4px 0; padding: 12px 16px; font-size: 11px; color: #333; }
  .footer-note { margin-top: 30px; font-size: 8.5px; color: #aaa; line-height: 1.6; border-top: 1px solid #f0f0f0; padding-top: 10px; }
</style>
</head>
<body>
<div class="doc">
  <div class="header">
    <div class="brand">Palladia &middot; Ricevuta</div>
    <div class="title">Scadenza intercettata</div>
    <div class="company">${esc(companyName)}</div>
  </div>

  <div class="row"><div class="label">Documento / lavorazione</div><div class="value">${esc(item.label)}</div></div>
  <div class="row"><div class="label">Notificata il</div><div class="value">${fmtDate(item.notified_at)}</div></div>
  <div class="row"><div class="label">Risolta il</div><div class="value">${fmtDate(item.resolved_at)}</div></div>

  ${hasSanction ? `
  <div class="sanction-box">
    <div class="sanction-amount">${fmtEuro(item.amount_min_cents)} evitati</div>
    <div class="sanction-label">${esc(item.violation_label)}</div>
    ${item.legal_reference ? `<div class="sanction-ref">${esc(item.legal_reference)}</div>` : ''}
    ${item.needs_review ? `<div class="review-note">Importo in fase di verifica legale — non ancora confermato da un consulente del lavoro.</div>` : ''}
  </div>` : `
  <div class="ok-box">Scadenza gestita in tempo grazie alla notifica anticipata di Palladia.</div>
  `}

  <div class="footer-note">
    Ricevuta generata automaticamente da Palladia sulla base dei dati della piattaforma. Non costituisce un documento legale o fiscale.
  </div>
</div>
</body>
</html>`;
}

router.get('/value-metrics/receipt.pdf', verifySupabaseJwt, async (req, res) => {
  const { entity_type: entityType, entity_id: entityId } = req.query;
  if (!entityType || !entityId) return res.status(400).json({ error: 'MISSING_PARAMS' });

  try {
    const { items } = await computeScadenzeESanzioni(req.companyId);
    const item = items.find(i => i.entity_type === entityType && i.entity_id === entityId);
    if (!item) return res.status(404).json({ error: 'NOT_FOUND' });

    const { data: company } = await supabase.from('companies').select('name').eq('id', req.companyId).maybeSingle();
    const html = buildReceiptHtml(item, company?.name || 'La tua impresa');
    const pdf  = await renderHtmlToPdf(html, { docTitle: 'Ricevuta scadenza intercettata', footerLeft: 'Ricevuta — dati verificabili' });

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="ricevuta-scadenza-${Date.now()}.pdf"`,
      'Cache-Control':       'no-store',
    });
    return res.send(pdf);
  } catch (err) {
    console.error('[value-metrics/receipt.pdf] error:', err.message);
    res.status(500).json({ error: 'EXPORT_ERROR', detail: err.message });
  }
});

module.exports = router;
