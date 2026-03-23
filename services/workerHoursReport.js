'use strict';
/**
 * services/workerHoursReport.js
 *
 * Report Ore Lavorate per Lavoratore
 *  – buildWorkerHoursReport(siteId, companyId, from, to, workerId?)  → ReportData
 *  – generateWorkerHoursPdfHtml(data)                                → HTML string (Puppeteer)
 *  – generateWorkerHoursXlsx(data)                                   → Buffer (.xlsx)
 *
 * Formato output consigliato per commercialisti / consulenti del lavoro:
 *  • PDF: documento professionale A4 con intestazione Palladia,
 *         riepilogo per lavoratore e dettaglio giornaliero
 *  • XLSX: 2 fogli — "Riepilogo" (una riga per lavoratore) +
 *           "Dettaglio" (una riga per giornata)
 */

const supabase = require('../lib/supabase');

// ── Timezone helpers (Europe/Rome) ────────────────────────────────────────────

function dateKeyRome(ts) {
  return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
}
function fmtDateRome(dateKey) {
  const [y, m, d] = dateKey.split('-');
  return `${d}/${m}/${y}`;
}
function fmtTimeRome(ts) {
  return new Date(ts).toLocaleTimeString('it-IT', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
  });
}
function italianWeekday(dateKey) {
  const days = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
  return days[new Date(dateKey + 'T12:00:00').getDay()];
}

/** "555 min" → "9h 15m" */
function fmtDuration(totalMinutes) {
  if (!totalMinutes || totalMinutes <= 0) return '0h 00m';
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** decimal hours for XLSX cells */
function toDecimalHours(totalMinutes) {
  return totalMinutes > 0 ? parseFloat((totalMinutes / 60).toFixed(2)) : 0;
}

function getWorkerName(w) {
  return w.full_name
    || [w.first_name, w.last_name].filter(Boolean).join(' ')
    || '—';
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Core data builder ─────────────────────────────────────────────────────────

async function buildWorkerHoursReport(siteId, companyId, from, to, workerId = null) {
  // Site
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, address, company_id')
    .eq('id', siteId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (siteErr) { const e = new Error(siteErr.message); e.status = 500; throw e; }
  if (!site)   { const e = new Error('Cantiere non trovato'); e.status = 404; throw e; }

  // Company
  const { data: company } = await supabase
    .from('companies').select('name').eq('id', companyId).maybeSingle();

  // Presence logs
  let q = supabase
    .from('presence_logs')
    .select(`
      id, worker_id, event_type, timestamp_server, distance_m, gps_accuracy_m,
      worker:workers (id, full_name, first_name, last_name, fiscal_code)
    `)
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .gte('timestamp_server', `${from}T00:00:00.000Z`)
    .lte('timestamp_server', `${to}T23:59:59.999Z`)
    .order('worker_id',        { ascending: true })
    .order('timestamp_server', { ascending: true })
    .limit(200000);

  if (workerId) q = q.eq('worker_id', workerId);

  const { data: logs, error: logsErr } = await q;
  if (logsErr) { const e = new Error(logsErr.message); e.status = 500; throw e; }

  // Group by worker → date
  const workerMap = new Map();
  for (const log of (logs || [])) {
    if (!log.worker) continue;
    const wId = log.worker_id;
    if (!workerMap.has(wId)) workerMap.set(wId, { info: log.worker, dayMap: new Map() });
    const dk = dateKeyRome(log.timestamp_server);
    const dm = workerMap.get(wId).dayMap;
    if (!dm.has(dk)) dm.set(dk, []);
    dm.get(dk).push(log);
  }

  const workers = [];

  for (const [wId, { info, dayMap }] of workerMap) {
    const days = [];
    let totalMinutes = 0;

    for (const dk of [...dayMap.keys()].sort()) {
      const dayLogs = dayMap.get(dk).slice().sort((a, b) => a.timestamp_server.localeCompare(b.timestamp_server));

      const entries = [];
      let dayMin = 0;
      let i = 0;

      while (i < dayLogs.length) {
        const cur  = dayLogs[i];
        const next = i + 1 < dayLogs.length ? dayLogs[i + 1] : null;

        if (cur.event_type === 'ENTRY') {
          if (next && next.event_type === 'EXIT') {
            const mins = Math.max(0, Math.round(
              (new Date(next.timestamp_server) - new Date(cur.timestamp_server)) / 60000
            ));
            entries.push({
              entry_time: fmtTimeRome(cur.timestamp_server),
              exit_time:  fmtTimeRome(next.timestamp_server),
              minutes:    mins,
              hours_str:  fmtDuration(mins),
              anomaly:    null,
            });
            dayMin += mins;
            i += 2;
          } else {
            entries.push({ entry_time: fmtTimeRome(cur.timestamp_server), exit_time: null, minutes: 0, hours_str: '—', anomaly: 'Uscita non registrata' });
            i += 1;
          }
        } else {
          entries.push({ entry_time: null, exit_time: fmtTimeRome(cur.timestamp_server), minutes: 0, hours_str: '—', anomaly: 'Entrata non registrata' });
          i += 1;
        }
      }

      totalMinutes += dayMin;
      days.push({
        date_key:          dk,
        date_formatted:    fmtDateRome(dk),
        weekday:           italianWeekday(dk),
        entries,
        day_total_minutes: dayMin,
        day_total_str:     fmtDuration(dayMin),
        has_anomaly:       entries.some(e => e.anomaly),
        is_overtime:       dayMin > 480, // > 8h
        overtime_minutes:  Math.max(0, dayMin - 480),
      });
    }

    const overtimeMinutes = days.reduce((s, d) => s + d.overtime_minutes, 0);
    workers.push({
      id:               wId,
      full_name:        getWorkerName(info),
      fiscal_code:      info.fiscal_code || '',
      total_days:       days.length,
      total_minutes:    totalMinutes,
      total_hours:      toDecimalHours(totalMinutes),
      total_hours_str:  fmtDuration(totalMinutes),
      overtime_minutes: overtimeMinutes,
      overtime_str:     overtimeMinutes > 0 ? fmtDuration(overtimeMinutes) : null,
      overtime_days:    days.filter(d => d.is_overtime).length,
      days,
    });
  }

  workers.sort((a, b) => a.full_name.localeCompare(b.full_name, 'it'));

  const [fy, fm, fd] = from.split('-');
  const [ty, tm, td] = to.split('-');

  return {
    site:      { id: site.id, name: site.name, address: site.address || '' },
    company:   { name: company?.name || '' },
    period:    { from, to, formatted: `${fd}/${fm}/${fy} — ${td}/${tm}/${ty}` },
    workers,
    totals: {
      workers_count:         workers.length,
      grand_total_minutes:   workers.reduce((s, w) => s + w.total_minutes, 0),
      grand_total_str:       fmtDuration(workers.reduce((s, w) => s + w.total_minutes, 0)),
      grand_overtime_minutes: workers.reduce((s, w) => s + w.overtime_minutes, 0),
      grand_overtime_str:    (() => { const m = workers.reduce((s, w) => s + w.overtime_minutes, 0); return m > 0 ? fmtDuration(m) : null; })(),
    },
    generated_at: new Date().toISOString(),
  };
}

// ── HTML → PDF (Puppeteer) ────────────────────────────────────────────────────

function generateWorkerHoursPdfHtml(data) {
  const { site, company, period, workers, totals, generated_at } = data;

  const genStr = new Date(generated_at).toLocaleString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
  });

  const summaryRows = workers.map(w => `
    <tr>
      <td>${esc(w.full_name)}</td>
      <td class="mono small">${esc(w.fiscal_code)}</td>
      <td class="center">${w.total_days}</td>
      <td class="right bold">${w.total_hours_str}</td>
      <td class="right">${w.overtime_str ? `<span class="ot-badge">${w.overtime_str}</span>` : '<span class="small" style="color:#aaa;">—</span>'}</td>
    </tr>`).join('');

  const workerSections = workers.map(w => {
    let dayRows = '';
    for (const d of w.days) {
      if (d.entries.length === 0) continue;
      for (let idx = 0; idx < d.entries.length; idx++) {
        const e   = d.entries[idx];
        const cls = e.anomaly ? 'anom' : (d.is_overtime && !e.anomaly ? 'ot-row' : '');
        const otBadge = d.is_overtime && idx === 0 && !e.anomaly
          ? `<span class="ot-badge">+${fmtDuration(d.overtime_minutes)} straord.</span>` : '';
        dayRows += `<tr class="${cls}">
          <td>${idx === 0 ? `<strong>${d.weekday}</strong> ${d.date_formatted}${otBadge}` : ''}</td>
          <td class="center">${e.entry_time || '—'}</td>
          <td class="center">${e.exit_time  || '—'}</td>
          <td class="right">${e.anomaly ? `<span class="anom-lbl">⚠ ${esc(e.anomaly)}</span>` : e.hours_str}</td>
        </tr>`;
      }
      if (d.entries.length > 1) {
        dayRows += `<tr class="day-sub-total">
          <td colspan="3" class="right small">Totale ${d.date_formatted}</td>
          <td class="right bold">${d.day_total_str}</td>
        </tr>`;
      }
    }

    return `<div class="worker-block">
      <div class="worker-hdr">
        <span class="wname">${esc(w.full_name)}</span>
        <span class="wcf">C.F.: ${esc(w.fiscal_code)}</span>
      </div>
      <table class="dtbl">
        <thead>
          <tr>
            <th style="width:30%">Data</th>
            <th class="center" style="width:18%">Entrata</th>
            <th class="center" style="width:18%">Uscita</th>
            <th class="right"  style="width:34%">Ore lavorate</th>
          </tr>
        </thead>
        <tbody>${dayRows}</tbody>
        <tfoot>
          <tr class="tot-row">
            <td colspan="2">TOTALE PERIODO</td>
            <td class="center">${w.total_days} giorn${w.total_days === 1 ? 'o' : 'i'}</td>
            <td class="right bold">${w.total_hours_str}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<style>
  @page { size:A4; margin:26mm 0 24mm 0; }
  *     { box-sizing:border-box; margin:0; padding:0; }
  body  { font-family:Arial,Helvetica,sans-serif; font-size:10pt; color:#1a1a1a; }
  .doc  { padding:0 16mm; }

  /* ── Report header ── */
  .rpt-header {
    display:flex; justify-content:space-between; align-items:flex-start;
    border-bottom:2px solid #1a1a1a; padding-bottom:10pt; margin-bottom:14pt;
  }
  .rpt-brand { font-size:18pt; font-weight:bold; letter-spacing:0.08em; }
  .rpt-title { font-size:11pt; font-weight:600; color:#444; margin-top:3pt; }
  .rpt-meta  { text-align:right; font-size:8.5pt; color:#666; line-height:1.6; }
  .rpt-meta strong { color:#1a1a1a; }

  /* ── Info box ── */
  .info-box {
    background:#f8f8f8; border:1px solid #e0e0e0; border-radius:4pt;
    padding:8pt 12pt; margin-bottom:16pt;
    display:grid; grid-template-columns:1fr 1fr; gap:4pt 20pt;
    font-size:9pt;
  }
  .info-row { display:flex; gap:6pt; }
  .info-lbl { color:#888; min-width:70pt; }
  .info-val { font-weight:600; }

  /* ── Section heading ── */
  .section-hdr {
    font-size:9pt; font-weight:700; text-transform:uppercase; letter-spacing:0.06em;
    color:#888; border-bottom:1px solid #ddd; padding-bottom:4pt; margin-bottom:8pt;
  }

  /* ── Summary table ── */
  .stbl { width:100%; border-collapse:collapse; margin-bottom:20pt; font-size:9.5pt; }
  .stbl thead tr { background:#1a1a1a; color:#fff; }
  .stbl thead th { padding:6pt 8pt; text-align:left; font-weight:600; }
  .stbl tbody tr:nth-child(even) { background:#f5f5f5; }
  .stbl tbody td { padding:5pt 8pt; border-bottom:1px solid #ebebeb; }
  .stbl tfoot tr { background:#1a1a1a; color:#fff; font-weight:700; }
  .stbl tfoot td { padding:6pt 8pt; }

  /* ── Worker block ── */
  .worker-block { margin-bottom:22pt; break-inside:avoid-page; }
  .worker-hdr {
    display:flex; align-items:baseline; gap:12pt;
    background:#1a1a1a; color:#fff; border-radius:4pt 4pt 0 0;
    padding:7pt 10pt;
  }
  .wname { font-size:11pt; font-weight:700; flex:1; }
  .wcf   { font-size:8.5pt; color:#ccc; font-family:monospace; }

  /* ── Detail table ── */
  .dtbl { width:100%; border-collapse:collapse; font-size:9pt; }
  .dtbl thead tr { background:#f0f0f0; }
  .dtbl thead th { padding:5pt 8pt; text-align:left; font-weight:600; border-bottom:2px solid #ddd; }
  .dtbl tbody tr:nth-child(even) { background:#fafafa; }
  .dtbl tbody td { padding:4.5pt 8pt; border-bottom:1px solid #ebebeb; }
  .dtbl tfoot .tot-row td { padding:6pt 8pt; background:#f0f0f0; border-top:2px solid #bbb; font-weight:600; }
  .dtbl .anom td { background:#fff8e1; }
  .dtbl .day-sub-total td { background:#f0f0f0; font-size:8.5pt; border-top:1px dashed #ccc; }
  .anom-lbl { color:#c0392b; font-size:8pt; }

  /* ── Utils ── */
  .center { text-align:center; }
  .right  { text-align:right; }
  .bold   { font-weight:700; }
  .small  { font-size:8.5pt; }
  .mono   { font-family:monospace; font-size:8.5pt; letter-spacing:0.04em; }

  /* ── Overtime highlight ── */
  .ot-badge {
    display:inline-block; background:#fef3c7; color:#92400e;
    border:1px solid #f59e0b; border-radius:3pt;
    font-size:7.5pt; font-weight:700; padding:0.5pt 4pt; margin-left:4pt;
  }
  .ot-row td { background:#fffbeb !important; }

  /* ── Signature block ── */
  .sig-section { margin-top:24pt; break-inside:avoid; page-break-inside:avoid; }
  .sig-grid { display:grid; grid-template-columns:1fr 1fr; gap:12mm; margin-top:10pt; }
  .sig-col  { font-size:8pt; color:#333; }
  .sig-role { font-size:7pt; font-weight:700; text-transform:uppercase;
    letter-spacing:0.7pt; color:#1a1a1a; margin-bottom:12mm; }
  .sig-line { border-bottom:0.5pt solid #333; margin-bottom:4pt; }
  .sig-lbl  { font-size:6.5pt; color:#888; }

  /* ── Footer note ── */
  .footer-note {
    margin-top:24pt; padding-top:8pt; border-top:1px solid #ddd;
    font-size:8pt; color:#999; text-align:center;
  }
</style>
</head>
<body>
<div class="doc">

  <!-- Header -->
  <div class="rpt-header">
    <div>
      <div class="rpt-brand">PALLADIA</div>
      <div class="rpt-title">Report Ore Lavorate — ${esc(site.name)}</div>
    </div>
    <div class="rpt-meta">
      <div><strong>Periodo:</strong> ${esc(period.formatted)}</div>
      <div><strong>Cantiere:</strong> ${esc(site.name)}</div>
      ${company.name ? `<div><strong>Azienda:</strong> ${esc(company.name)}</div>` : ''}
      <div>Generato il: ${genStr}</div>
    </div>
  </div>

  <!-- Info box -->
  <div class="info-box">
    <div class="info-row"><span class="info-lbl">Cantiere</span><span class="info-val">${esc(site.name)}</span></div>
    <div class="info-row"><span class="info-lbl">Periodo</span><span class="info-val">${esc(period.formatted)}</span></div>
    ${site.address ? `<div class="info-row"><span class="info-lbl">Indirizzo</span><span class="info-val">${esc(site.address)}</span></div>` : ''}
    <div class="info-row"><span class="info-lbl">Lavoratori</span><span class="info-val">${totals.workers_count}</span></div>
    <div class="info-row"><span class="info-lbl">Ore totali</span><span class="info-val">${totals.grand_total_str}</span></div>
    ${company.name ? `<div class="info-row"><span class="info-lbl">Azienda</span><span class="info-val">${esc(company.name)}</span></div>` : ''}
  </div>

  <!-- Summary -->
  <div class="section-hdr">Riepilogo per Lavoratore</div>
  <table class="stbl">
    <thead>
      <tr>
        <th style="width:35%">Lavoratore</th>
        <th style="width:25%">Codice Fiscale</th>
        <th class="center" style="width:10%">Giorni</th>
        <th class="right"  style="width:15%">Ore Totali</th>
        <th class="right"  style="width:15%">Straordinari</th>
      </tr>
    </thead>
    <tbody>${summaryRows}</tbody>
    <tfoot>
      <tr>
        <td colspan="2">TOTALE COMPLESSIVO</td>
        <td class="center">${workers.reduce((s, w) => s + w.total_days, 0)} giornate</td>
        <td class="right">${totals.grand_total_str}</td>
        <td class="right">${totals.grand_overtime_str || '—'}</td>
      </tr>
    </tfoot>
  </table>

  <!-- Worker details -->
  <div class="section-hdr">Dettaglio per Lavoratore</div>
  ${workerSections}

  <div class="footer-note">
    Documento generato da Palladia · ${genStr} · Dati raccolti tramite badge digitale con verifica GPS
  </div>

  <!-- Firme -->
  <div class="sig-section">
    <div class="section-hdr" style="margin-top:20pt;">Attestazione e firme</div>
    <div class="sig-grid">
      <div class="sig-col">
        <div class="sig-role">Datore di Lavoro / Rappresentante Legale</div>
        <div class="sig-line"></div>
        <div class="sig-lbl">Nome e cognome: _________________________________</div>
        <br>
        <div class="sig-lbl">Data: _____________________&emsp;Firma: _________________________________</div>
      </div>
      <div class="sig-col">
        <div class="sig-role">Consulente del Lavoro / Responsabile Paghe</div>
        <div class="sig-line"></div>
        <div class="sig-lbl">Nome e cognome: _________________________________</div>
        <br>
        <div class="sig-lbl">Data: _____________________&emsp;Firma: _________________________________</div>
      </div>
    </div>
  </div>

</div>
</body>
</html>`;
}

// ── XLSX builder ──────────────────────────────────────────────────────────────

function generateWorkerHoursXlsx(data) {
  const XLSX = require('xlsx');
  const { site, company, period, workers, totals, generated_at } = data;

  const genStr = new Date(generated_at).toLocaleString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
  });

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Riepilogo ────────────────────────────────────────────────────
  const summaryData = [
    [`PALLADIA — Report Ore Lavorate`],
    [`Cantiere: ${site.name}`],
    [`Periodo: ${period.formatted}`],
    company.name ? [`Azienda: ${company.name}`] : [],
    [`Generato il: ${genStr}`],
    [],
    ['Lavoratore', 'Codice Fiscale', 'Giorni Lavorati', 'Ore Totali (h)', 'Ore Totali (decimale)'],
    ...workers.map(w => [
      w.full_name,
      w.fiscal_code,
      w.total_days,
      w.total_hours_str,
      w.total_hours,
    ]),
    [],
    ['TOTALE COMPLESSIVO', '', workers.reduce((s, w) => s + w.total_days, 0), totals.grand_total_str, parseFloat((workers.reduce((s, w) => s + w.total_minutes, 0) / 60).toFixed(2))],
  ].filter(r => r.length > 0);

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);

  // Column widths
  wsSummary['!cols'] = [
    { wch: 30 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 20 },
  ];

  XLSX.utils.book_append_sheet(wb, wsSummary, 'Riepilogo');

  // ── Sheet 2: Dettaglio giornaliero ────────────────────────────────────────
  const detailRows = [
    ['Lavoratore', 'Codice Fiscale', 'Data', 'Giorno', 'Entrata', 'Uscita', 'Ore (h)', 'Ore (decimale)', 'Note / Anomalie'],
  ];

  for (const w of workers) {
    for (const d of w.days) {
      for (let idx = 0; idx < d.entries.length; idx++) {
        const e = d.entries[idx];
        detailRows.push([
          w.full_name,
          w.fiscal_code,
          d.date_formatted,
          d.weekday,
          e.entry_time || '',
          e.exit_time  || '',
          e.hours_str,
          toDecimalHours(e.minutes),
          e.anomaly || '',
        ]);
      }
      // Sub-total row for multi-interval days
      if (d.entries.length > 1) {
        detailRows.push([
          '', '', d.date_formatted, '→ Totale giorno', '', '',
          d.day_total_str, toDecimalHours(d.day_total_minutes), '',
        ]);
      }
    }
    // Worker subtotal
    detailRows.push([
      `SUBTOTALE: ${w.full_name}`, '', '', '', '', '',
      w.total_hours_str, w.total_hours, `${w.total_days} giorni`,
    ]);
    detailRows.push([]); // spacer
  }

  const wsDetail = XLSX.utils.aoa_to_sheet(detailRows);
  wsDetail['!cols'] = [
    { wch: 28 }, { wch: 18 }, { wch: 12 }, { wch: 12 },
    { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 28 },
  ];

  XLSX.utils.book_append_sheet(wb, wsDetail, 'Dettaglio Giornaliero');

  // ── Sheet 3: Anomalie ─────────────────────────────────────────────────────
  const anomalyRows = [
    ['Lavoratore', 'Codice Fiscale', 'Data', 'Entrata', 'Uscita', 'Anomalia'],
  ];
  for (const w of workers) {
    for (const d of w.days) {
      for (const e of d.entries) {
        if (e.anomaly) {
          anomalyRows.push([w.full_name, w.fiscal_code, d.date_formatted, e.entry_time || '', e.exit_time || '', e.anomaly]);
        }
      }
    }
  }
  if (anomalyRows.length > 1) {
    const wsAnom = XLSX.utils.aoa_to_sheet(anomalyRows);
    wsAnom['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, wsAnom, 'Anomalie');
  }

  return XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
}

module.exports = { buildWorkerHoursReport, generateWorkerHoursPdfHtml, generateWorkerHoursXlsx, fmtDuration };
