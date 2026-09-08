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
const { pairLogsByDay, shiftDateStr, resolveLunchBreakConfig, applyLunchBreak } = require('../lib/presencePairing');

// Un consulente del lavoro deve poter distinguere una timbratura reale da una
// generata dal sistema o corretta a mano — altrimenti tratta un dato rettificato
// come se fosse la lettura originale del dispositivo.
const METHOD_NOTE = {
  admin_manual_correction:       'Corretto manualmente',
  auto_exit_on_site_change:      'Uscita auto (cambio cantiere)',
  // F-146 (AUDIT.md): mancavano queste due — un'uscita indovinata dal
  // sistema finiva in busta paga identica a una timbratura reale, senza
  // alcuna annotazione (services/missingExitCron.js, ladiaActions.js e il
  // guard anti-turno-fantasma in migrations/161_punch_atomic_...sql).
  ladia_action:                  'Uscita auto (turno lasciato aperto)',
  auto_exit_stale_before_reopen: 'Uscita auto (turno anomalo, chiuso automaticamente)',
};

// ── Timezone helpers (Europe/Rome) ────────────────────────────────────────────

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
  const singleSite = !!siteId;

  // Site(s) — un solo cantiere (richiesto) oppure tutti quelli dell'azienda
  // (F-151, AUDIT.md: "tutti i cantieri" ora è un export valido, non solo un
  // filtro bloccato). Servono anche per risolvere la config pausa pranzo per
  // cantiere (override) — vedi resolveLunchBreakConfig.
  const SITE_COLS = 'id, name, address, company_id, lunch_break_minutes, lunch_break_threshold_hours';
  let sitesRows;
  if (singleSite) {
    const { data: site, error: siteErr } = await supabase
      .from('sites').select(SITE_COLS).eq('id', siteId).eq('company_id', companyId).maybeSingle();
    if (siteErr) { const e = new Error(siteErr.message); e.status = 500; throw e; }
    if (!site)   { const e = new Error('Cantiere non trovato'); e.status = 404; throw e; }
    sitesRows = [site];
  } else {
    const { data: sites, error: sitesErr } = await supabase
      .from('sites').select(SITE_COLS).eq('company_id', companyId).limit(1000);
    if (sitesErr) { const e = new Error(sitesErr.message); e.status = 500; throw e; }
    sitesRows = sites || [];
  }
  const siteById = new Map(sitesRows.map(s => [s.id, s]));

  // Company (nome + default pausa pranzo, ereditato dai cantieri senza override)
  const { data: company } = await supabase
    .from('companies')
    .select('name, lunch_break_minutes, lunch_break_threshold_hours')
    .eq('id', companyId).maybeSingle();

  // Presence logs
  // Finestra allargata di 1 giorno intero su ciascun lato (oltre al consueto
  // +02:00/+01:00 invece di Z): permette di accoppiare correttamente anche un
  // turno a cavallo del bordo from/to — il pairing avviene su tutto lo stream
  // cronologico del lavoratore (lib/presencePairing.js), poi si scartano i
  // giorni fuori [from,to].
  const fetchFrom = shiftDateStr(from, -1);
  const fetchTo   = shiftDateStr(to, 1);
  let q = supabase
    .from('presence_logs')
    .select(`
      id, worker_id, site_id, event_type, timestamp_server, distance_m, gps_accuracy_m, method,
      worker:workers (id, full_name, first_name, last_name, fiscal_code)
    `)
    .eq('company_id', companyId)
    .gte('timestamp_server', `${fetchFrom}T00:00:00+02:00`)
    .lte('timestamp_server', `${fetchTo}T23:59:59.999+01:00`)
    .order('worker_id',        { ascending: true })
    .order('timestamp_server', { ascending: true })
    .limit(200000);

  if (singleSite) q = q.eq('site_id', siteId);
  if (workerId)   q = q.eq('worker_id', workerId);

  const { data: logs, error: logsErr } = await q;
  if (logsErr) { const e = new Error(logsErr.message); e.status = 500; throw e; }

  // Group by (worker, cantiere) — stream cronologico completo, non ancora per
  // giorno. Necessario in modalità "tutti i cantieri": il pairing va fatto
  // separatamente per cantiere (un cambio cantiere chiude sempre l'ENTRY
  // precedente con un EXIT auto, method auto_exit_on_site_change), e la
  // config pausa pranzo può differire da un cantiere all'altro.
  const groupMap = new Map();
  for (const log of (logs || [])) {
    if (!log.worker) continue;
    const key = `${log.worker_id}__${log.site_id}`;
    if (!groupMap.has(key)) groupMap.set(key, { workerId: log.worker_id, siteId: log.site_id, info: log.worker, logs: [] });
    groupMap.get(key).logs.push(log);
  }

  const perWorker = new Map(); // worker_id → { info, days: [] }

  for (const { workerId: wId, siteId: gSiteId, info, logs: groupLogs } of groupMap.values()) {
    const site = siteById.get(gSiteId);
    const siteName = site?.name || '—';
    const lunchConfig = resolveLunchBreakConfig(company, site);

    const dayMap = pairLogsByDay(groupLogs);   // ← accoppia PRIMA, sull'intero stream

    if (!perWorker.has(wId)) perWorker.set(wId, { info, days: [] });
    const workerAgg = perWorker.get(wId);

    for (const dk of [...dayMap.keys()].sort()) {
      if (dk < from || dk > to) continue;   // fuori dal periodo richiesto
      const { pairs, orphanEntries, orphanExits } = dayMap.get(dk);
      if (pairs.length === 0 && orphanEntries.length === 0 && orphanExits.length === 0) continue;

      // Detrazione pausa pranzo (F-152, AUDIT.md) — solo se il giorno è
      // un'unica coppia continua sopra soglia; se ci sono 2+ coppie il
      // lavoratore ha già timbrato una pausa reale, già esclusa dalla somma.
      const lunchResults  = applyLunchBreak(pairs, lunchConfig);
      const minutesByEntryId = new Map(lunchResults.map(r => [r.entry.id, r]));

      // Ricompone l'ordine cronologico del giorno tra coppie e orfani
      const dayEvents = [
        ...pairs.map(p => ({ ts: p.entry.timestamp_server, pair: p })),
        ...orphanEntries.map(l => ({ ts: l.timestamp_server, orphanEntry: l })),
        ...orphanExits.map(l => ({ ts: l.timestamp_server, orphanExit: l })),
      ].sort((a, b) => a.ts.localeCompare(b.ts));

      const entries = [];
      let dayMin = 0;
      let dayLunchBreakMinutes = 0;

      for (const ev of dayEvents) {
        if (ev.pair) {
          const { entry, exit } = ev.pair;
          const lr   = minutesByEntryId.get(entry.id);
          const mins = lr.minutes;
          entries.push({
            entry_time:          fmtTimeRome(entry.timestamp_server),
            exit_time:           fmtTimeRome(exit.timestamp_server),
            minutes:             mins,
            hours_str:           fmtDuration(mins),
            anomaly:             METHOD_NOTE[exit.method] || METHOD_NOTE[entry.method] || null,
            lunch_break_minutes: lr.lunchBreakMinutes || 0,
            site_name:           siteName,
          });
          dayMin += mins;
          dayLunchBreakMinutes += lr.lunchBreakMinutes || 0;
        } else if (ev.orphanEntry) {
          entries.push({ entry_time: fmtTimeRome(ev.orphanEntry.timestamp_server), exit_time: null, minutes: 0, hours_str: '—', anomaly: 'Uscita non registrata', lunch_break_minutes: 0, site_name: siteName });
        } else {
          entries.push({ entry_time: null, exit_time: fmtTimeRome(ev.orphanExit.timestamp_server), minutes: 0, hours_str: '—', anomaly: 'Entrata non registrata', lunch_break_minutes: 0, site_name: siteName });
        }
      }

      workerAgg.days.push({
        date_key:               dk,
        date_formatted:         fmtDateRome(dk),
        weekday:                italianWeekday(dk),
        site_name:              siteName,
        entries,
        day_total_minutes:      dayMin,
        day_total_str:          fmtDuration(dayMin),
        has_anomaly:            entries.some(e => e.anomaly),
        is_overtime:            dayMin > 480, // > 8h
        overtime_minutes:       Math.max(0, dayMin - 480),
        lunch_break_minutes:    dayLunchBreakMinutes,
        has_lunch_break_deduction: dayLunchBreakMinutes > 0,
      });
    }
  }

  const workers = [];
  for (const [wId, { info, days }] of perWorker) {
    days.sort((a, b) => a.date_key.localeCompare(b.date_key));
    const totalMinutes    = days.reduce((s, d) => s + d.day_total_minutes, 0);
    const overtimeMinutes = days.reduce((s, d) => s + d.overtime_minutes, 0);
    const lunchBreakTotal = days.reduce((s, d) => s + d.lunch_break_minutes, 0);
    workers.push({
      id:                    wId,
      full_name:             getWorkerName(info),
      fiscal_code:           info.fiscal_code || '',
      total_days:            days.length,
      total_minutes:         totalMinutes,
      total_hours:           toDecimalHours(totalMinutes),
      total_hours_str:       fmtDuration(totalMinutes),
      overtime_minutes:      overtimeMinutes,
      overtime_str:          overtimeMinutes > 0 ? fmtDuration(overtimeMinutes) : null,
      overtime_days:         days.filter(d => d.is_overtime).length,
      lunch_break_minutes:   lunchBreakTotal,
      days,
    });
  }

  workers.sort((a, b) => a.full_name.localeCompare(b.full_name, 'it'));

  const [fy, fm, fd] = from.split('-');
  const [ty, tm, td] = to.split('-');

  return {
    site: singleSite
      ? { id: sitesRows[0].id, name: sitesRows[0].name, address: sitesRows[0].address || '' }
      : { id: null, name: 'Tutti i cantieri', address: '' },
    single_site: singleSite,
    company:   { name: company?.name || '' },
    period:    { from, to, formatted: `${fd}/${fm}/${fy} — ${td}/${tm}/${ty}` },
    workers,
    totals: {
      workers_count:         workers.length,
      grand_total_minutes:   workers.reduce((s, w) => s + w.total_minutes, 0),
      grand_total_str:       fmtDuration(workers.reduce((s, w) => s + w.total_minutes, 0)),
      grand_overtime_minutes: workers.reduce((s, w) => s + w.overtime_minutes, 0),
      grand_overtime_str:    (() => { const m = workers.reduce((s, w) => s + w.overtime_minutes, 0); return m > 0 ? fmtDuration(m) : null; })(),
      grand_lunch_break_minutes: workers.reduce((s, w) => s + w.lunch_break_minutes, 0),
    },
    generated_at: new Date().toISOString(),
  };
}

// ── HTML → PDF (Puppeteer) ────────────────────────────────────────────────────

function generateWorkerHoursPdfHtml(data) {
  const { site, company, period, workers, totals, generated_at, single_site: singleSite } = data;

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
        const siteTag = singleSite ? '' : ` <span class="small" style="color:#888;">— ${esc(d.site_name)}</span>`;
        const lunchTag = e.lunch_break_minutes > 0
          ? `<span class="lunch-badge">−${e.lunch_break_minutes}m pausa pranzo</span>` : '';
        dayRows += `<tr class="${cls}">
          <td>${idx === 0 ? `<strong>${d.weekday}</strong> ${d.date_formatted}${siteTag}${otBadge}` : ''}</td>
          <td class="center">${e.entry_time || '—'}</td>
          <td class="center">${e.exit_time  || '—'}</td>
          <td class="right">${e.anomaly ? `<span class="anom-lbl">⚠ ${esc(e.anomaly)}</span>` : `${e.hours_str}${lunchTag}`}</td>
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

  /* ── Pausa pranzo automatica (F-152) ── */
  .lunch-badge {
    display:inline-block; background:#eef2ff; color:#3730a3;
    border:1px solid #c7d2fe; border-radius:3pt;
    font-size:7pt; font-weight:600; padding:0.5pt 4pt; margin-left:4pt;
  }

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
      <div class="rpt-brand" style="display:flex;align-items:center;gap:6pt">PALLADIA</div>
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
    ${totals.grand_lunch_break_minutes > 0 ? `<div class="info-row"><span class="info-lbl">Pausa pranzo</span><span class="info-val">−${fmtDuration(totals.grand_lunch_break_minutes)} detratti automaticamente (vedi dettaglio)</span></div>` : ''}
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

// ── XLSX builder (ExcelJS — styled, professional) ─────────────────────────────

async function generateWorkerHoursXlsx(data) {
  const ExcelJS = require('exceljs');
  const { site, company, period, workers, totals, generated_at } = data;

  const genStr = new Date(generated_at).toLocaleString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
  });

  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Palladia';
  wb.created  = new Date(generated_at);
  wb.modified = new Date();

  // ── Style presets ─────────────────────────────────────────────────────────
  const DARK   = '1a1a1a';
  const WHITE  = 'FFFFFF';
  const AMBER  = 'FEF3C7';  // overtime row bg
  const RED_BG = 'FFF1F0';  // anomaly row bg
  const GRAY   = 'F5F5F5';  // alternating row
  const TOTAL_BG = 'EBEBEB';

  function headerCell(ws, row, col, value, width) {
    const cell = ws.getCell(row, col);
    cell.value = value;
    cell.font  = { bold: true, color: { argb: WHITE }, name: 'Arial', size: 10 };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
    cell.border = {
      top: { style: 'thin', color: { argb: DARK } },
      bottom: { style: 'thin', color: { argb: DARK } },
      left: { style: 'thin', color: { argb: DARK } },
      right: { style: 'thin', color: { argb: DARK } },
    };
    if (width) ws.getColumn(col).width = width;
  }

  function dataCell(cell, value, opts = {}) {
    cell.value = value;
    cell.font  = { name: 'Arial', size: 9, bold: opts.bold || false, color: { argb: opts.color || '1a1a1a' } };
    if (opts.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
    cell.alignment = { vertical: 'middle', horizontal: opts.align || 'left', wrapText: false };
    if (opts.border) {
      cell.border = { bottom: { style: 'thin', color: { argb: 'DDDDDD' } } };
    }
    if (opts.numFmt) cell.numFmt = opts.numFmt;
  }

  function metaRow(ws, label, value) {
    const r = ws.addRow([label, value]);
    r.getCell(1).font = { name: 'Arial', size: 9, bold: true, color: { argb: '666666' } };
    r.getCell(2).font = { name: 'Arial', size: 9, color: { argb: '1a1a1a' } };
    r.height = 16;
  }

  // ── Sheet 1: Riepilogo ────────────────────────────────────────────────────
  const ws1 = wb.addWorksheet('Riepilogo');
  ws1.properties.defaultRowHeight = 18;

  // Title
  ws1.mergeCells('A1:E1');
  const titleCell = ws1.getCell('A1');
  titleCell.value = 'PALLADIA — Report Ore Lavorate';
  titleCell.font  = { name: 'Arial', size: 14, bold: true, color: { argb: DARK } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
  ws1.getRow(1).height = 28;

  ws1.addRow([]);
  metaRow(ws1, 'Cantiere', site.name);
  if (site.address) metaRow(ws1, 'Indirizzo', site.address);
  metaRow(ws1, 'Periodo', period.formatted);
  if (company.name) metaRow(ws1, 'Azienda', company.name);
  if (totals.grand_lunch_break_minutes > 0) {
    metaRow(ws1, 'Pausa pranzo', `−${fmtDuration(totals.grand_lunch_break_minutes)} detratti automaticamente (vedi colonna "Pausa pranzo" nel foglio Dettaglio)`);
  }
  metaRow(ws1, 'Generato il', genStr);
  ws1.addRow([]);

  // Header row
  const hdrRowNum = ws1.lastRow.number + 1;
  const hdrCols = [
    ['Lavoratore', 32], ['Codice Fiscale', 20], ['Giorni Lavorati', 16],
    ['Ore Totali', 14], ['Ore (decimale)', 16], ['Straordinari', 14],
  ];
  hdrCols.forEach(([label, w], i) => headerCell(ws1, hdrRowNum, i + 1, label, w));
  ws1.getRow(hdrRowNum).height = 22;
  ws1.views = [{ state: 'frozen', ySplit: hdrRowNum }];

  // Data rows
  workers.forEach((w, idx) => {
    const r = ws1.addRow([]);
    const bg = idx % 2 === 1 ? GRAY : null;
    dataCell(r.getCell(1), w.full_name, { bold: false, bg, border: true });
    dataCell(r.getCell(2), w.fiscal_code, { bg, border: true, align: 'center' });
    dataCell(r.getCell(3), w.total_days, { bg, border: true, align: 'center' });
    dataCell(r.getCell(4), w.total_hours_str, { bg, border: true, align: 'right', bold: true });
    dataCell(r.getCell(5), w.total_hours, { bg, border: true, align: 'right', numFmt: '0.00' });
    dataCell(r.getCell(6), w.overtime_str || '—', {
      bg: w.overtime_minutes > 0 ? AMBER : bg,
      border: true, align: 'center',
      color: w.overtime_minutes > 0 ? '92400E' : '999999',
      bold: w.overtime_minutes > 0,
    });
    r.height = 18;
  });

  // Total row
  const totRow = ws1.addRow([]);
  totRow.height = 22;
  const grandTotal = parseFloat((workers.reduce((s, w) => s + w.total_minutes, 0) / 60).toFixed(2));
  const totCells = [
    ['TOTALE COMPLESSIVO', 'left'],
    ['', 'center'],
    [workers.reduce((s, w) => s + w.total_days, 0), 'center'],
    [totals.grand_total_str, 'right'],
    [grandTotal, 'right'],
    [totals.grand_overtime_str || '—', 'center'],
  ];
  totCells.forEach(([val, align], i) => {
    const cell = totRow.getCell(i + 1);
    cell.value = val;
    cell.font  = { name: 'Arial', size: 10, bold: true, color: { argb: WHITE } };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
    cell.alignment = { vertical: 'middle', horizontal: align };
    if (i === 4 && typeof val === 'number') cell.numFmt = '0.00';
  });

  ws1.autoFilter = { from: { row: hdrRowNum, column: 1 }, to: { row: hdrRowNum, column: 6 } };

  // ── Sheet 2: Dettaglio Giornaliero ────────────────────────────────────────
  const ws2 = wb.addWorksheet('Dettaglio Giornaliero');
  ws2.properties.defaultRowHeight = 17;

  const det2Cols = [
    ['Lavoratore', 28], ['Codice Fiscale', 18], ['Cantiere', 22], ['Data', 12],
    ['Giorno', 8], ['Entrata', 10], ['Uscita', 10], ['Pausa pranzo', 14],
    ['Ore (h)', 12], ['Ore (dec.)', 12], ['Note / Anomalie', 32],
  ];
  det2Cols.forEach(([label, w], i) => headerCell(ws2, 1, i + 1, label, w));
  ws2.getRow(1).height = 22;
  ws2.views = [{ state: 'frozen', ySplit: 1 }];
  ws2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 11 } };

  let altIdx = 0;
  for (const w of workers) {
    for (const d of w.days) {
      for (let ei = 0; ei < d.entries.length; ei++) {
        const e  = d.entries[ei];
        const bg = e.anomaly ? RED_BG : (d.is_overtime ? AMBER : (altIdx % 2 === 1 ? GRAY : null));
        const r  = ws2.addRow([]);
        r.height = 17;
        dataCell(r.getCell(1), ei === 0 ? w.full_name : '', { bg, border: true });
        dataCell(r.getCell(2), ei === 0 ? w.fiscal_code : '', { bg, border: true, align: 'center' });
        dataCell(r.getCell(3), e.site_name || '—', { bg, border: true, align: 'center' });
        dataCell(r.getCell(4), d.date_formatted, { bg, border: true, align: 'center' });
        dataCell(r.getCell(5), d.weekday, { bg, border: true, align: 'center' });
        dataCell(r.getCell(6), e.entry_time || '—', { bg, border: true, align: 'center' });
        dataCell(r.getCell(7), e.exit_time  || '—', { bg, border: true, align: 'center' });
        dataCell(r.getCell(8), e.lunch_break_minutes > 0 ? `−${e.lunch_break_minutes}m` : '—', {
          bg: e.lunch_break_minutes > 0 ? 'EEF2FF' : bg, border: true, align: 'center',
          color: e.lunch_break_minutes > 0 ? '3730A3' : '999999',
        });
        dataCell(r.getCell(9), e.hours_str, { bg, border: true, align: 'right', bold: !e.anomaly });
        dataCell(r.getCell(10), toDecimalHours(e.minutes), { bg, border: true, align: 'right', numFmt: '0.00' });
        dataCell(r.getCell(11), e.anomaly || '', {
          bg, border: true,
          color: e.anomaly ? 'C0392B' : '1a1a1a',
          bold: !!e.anomaly,
        });
      }
      // Sub-total for multi-interval days
      if (d.entries.length > 1) {
        const r = ws2.addRow([]);
        r.height = 16;
        for (let c = 1; c <= 11; c++) {
          r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_BG } };
          r.getCell(c).font = { name: 'Arial', size: 8.5, italic: true };
        }
        dataCell(r.getCell(4), d.date_formatted, { bg: TOTAL_BG, align: 'center' });
        dataCell(r.getCell(5), '→ tot.', { bg: TOTAL_BG, align: 'center' });
        dataCell(r.getCell(9), d.day_total_str, { bg: TOTAL_BG, align: 'right', bold: true });
        dataCell(r.getCell(10), toDecimalHours(d.day_total_minutes), { bg: TOTAL_BG, align: 'right', numFmt: '0.00' });
      }
      altIdx++;
    }
    // Worker subtotal
    const sr = ws2.addRow([]);
    sr.height = 20;
    for (let c = 1; c <= 11; c++) {
      sr.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
      sr.getCell(c).font = { name: 'Arial', size: 9, bold: true, color: { argb: WHITE } };
    }
    sr.getCell(1).value = `SUBTOTALE — ${w.full_name}`;
    sr.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
    sr.getCell(9).value = w.total_hours_str;
    sr.getCell(9).alignment = { horizontal: 'right', vertical: 'middle' };
    sr.getCell(10).value = w.total_hours;
    sr.getCell(10).alignment = { horizontal: 'right', vertical: 'middle' };
    sr.getCell(10).numFmt = '0.00';
    sr.getCell(11).value = `${w.total_days} giorni`;
    sr.getCell(11).alignment = { horizontal: 'center', vertical: 'middle' };
    ws2.addRow([]);
    altIdx = 0;
  }

  // ── Sheet 3: Anomalie (solo se presenti) ──────────────────────────────────
  const anomalies = [];
  for (const w of workers) {
    for (const d of w.days) {
      for (const e of d.entries) {
        if (e.anomaly) anomalies.push({ w, d, e });
      }
    }
  }

  if (anomalies.length > 0) {
    const ws3 = wb.addWorksheet('Anomalie');
    ws3.properties.defaultRowHeight = 17;
    const anCols = [
      ['Lavoratore', 28], ['Codice Fiscale', 18], ['Data', 12],
      ['Entrata', 10], ['Uscita', 10], ['Anomalia', 34],
    ];
    anCols.forEach(([label, w], i) => headerCell(ws3, 1, i + 1, label, w));
    ws3.getRow(1).height = 22;
    ws3.views = [{ state: 'frozen', ySplit: 1 }];

    anomalies.forEach(({ w, d, e }, idx) => {
      const r = ws3.addRow([]);
      r.height = 17;
      const bg = idx % 2 === 1 ? 'FFF8F8' : RED_BG;
      dataCell(r.getCell(1), w.full_name,    { bg, border: true });
      dataCell(r.getCell(2), w.fiscal_code,  { bg, border: true, align: 'center' });
      dataCell(r.getCell(3), d.date_formatted, { bg, border: true, align: 'center' });
      dataCell(r.getCell(4), e.entry_time || '—', { bg, border: true, align: 'center' });
      dataCell(r.getCell(5), e.exit_time  || '—', { bg, border: true, align: 'center' });
      dataCell(r.getCell(6), e.anomaly,     { bg, border: true, bold: true, color: 'C0392B' });
    });

    ws3.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { buildWorkerHoursReport, generateWorkerHoursPdfHtml, generateWorkerHoursXlsx, fmtDuration };
