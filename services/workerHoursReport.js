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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  /* Redesign F-154 (AUDIT.md, 2026-09-08): stile/font/colori reali di
     Palladia (Plus Jakarta Sans, palette dell'app) — mockup approvato. */
  :root {
    --primary: #22384F; --primary-tint: #EEF2F6;
    --text: #1A1714; --muted: #7A736A; --muted-2: #9C948A;
    --border: #E7E2D8; --border-strong: #D8D1C3;
    --success: #4A7358; --success-bg: #EEF3EE;
    --warning: #A8672A; --warning-bg: #FBF3E8;
    --destructive: #A8453B; --destructive-bg: #FBF0EE;
  }
  @page { size:A4; margin:26mm 0 24mm 0; }
  *     { box-sizing:border-box; margin:0; padding:0; }
  body  { font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif; font-size:9.5pt; color:var(--text); }
  table { color: var(--text); } /* esplicito: non sempre ereditato dal genitore in ogni motore */
  .doc  { padding:0 16mm; }

  /* ── Intestazione ── */
  .doc-eyebrow {
    display:inline-flex; align-items:center; gap:6pt;
    font-size:7.5pt; font-weight:700; letter-spacing:0.9pt; text-transform:uppercase;
    color:var(--primary); background:var(--primary-tint);
    padding:3pt 7pt 3pt 5pt; border-radius:2.5pt; margin-bottom:8pt;
  }
  .doc-title { font-size:19pt; font-weight:700; letter-spacing:-0.3pt; color:var(--text); line-height:1.2; margin-bottom:3pt; }
  .doc-title-rule { width:22pt; height:2.5pt; background:var(--primary); border-radius:2pt; margin:8pt 0 12pt; }

  .meta-grid {
    display:grid; grid-template-columns:repeat(4,1fr); gap:8pt 10pt;
    margin-bottom:14pt; padding-bottom:12pt; border-bottom:0.75pt solid var(--border);
  }
  .meta-k { font-size:6.5pt; font-weight:700; letter-spacing:0.6pt; text-transform:uppercase; color:var(--muted-2); margin-bottom:1.5pt; }
  .meta-v { font-size:9.5pt; font-weight:600; color:var(--text); line-height:1.35; }

  /* ── Section label ── */
  .section-hdr {
    display:flex; align-items:center; gap:7pt;
    font-size:7.5pt; font-weight:700; letter-spacing:0.7pt; text-transform:uppercase;
    color:var(--muted); margin-top:16pt; margin-bottom:8pt;
  }
  .section-hdr::after { content:""; flex:1; height:0.75pt; background:var(--border); }
  .section-hdr:first-of-type { margin-top:0; }

  /* ── Summary table ── */
  .stbl { width:100%; border-collapse:collapse; margin-bottom:18pt; font-size:8.8pt; }
  .stbl thead th { padding:0 6pt 6pt 0; text-align:left; font-size:6.5pt; font-weight:700;
    letter-spacing:0.4pt; text-transform:uppercase; color:var(--muted); border-bottom:1.5pt solid var(--text); }
  .stbl tbody td { padding:6pt 6pt 6pt 0; box-shadow: inset 0 -0.75pt 0 var(--border); }
  .stbl tfoot td { padding:7pt 6pt 7pt 0; font-weight:700; background:var(--primary-tint);
    box-shadow: inset 0 1.5pt 0 var(--text); }
  .stbl tfoot tr td:first-child { border-radius:3pt 0 0 3pt; }
  .stbl tfoot tr td:last-child  { border-radius:0 3pt 3pt 0; }

  /* ── Worker block ── */
  .worker-block { margin-bottom:20pt; break-inside:avoid-page; }
  .worker-hdr {
    display:flex; align-items:baseline; justify-content:space-between; gap:12pt;
    padding:9pt 0; border-bottom:1.5pt solid var(--text); margin-bottom:2pt;
  }
  .wname { font-size:11.5pt; font-weight:700; }
  .wcf   { font-size:7.5pt; color:var(--muted); font-family:'JetBrains Mono','Courier New',monospace; }

  /* ── Detail table ── */
  .dtbl { width:100%; border-collapse:collapse; font-size:8.5pt; }
  .dtbl thead th { padding:0 6pt 6pt 0; text-align:left; font-size:6.5pt; font-weight:700;
    letter-spacing:0.4pt; text-transform:uppercase; color:var(--muted); border-bottom:1.5pt solid var(--text); }
  .dtbl tbody td { padding:7pt 6pt 7pt 0; vertical-align:top; box-shadow: inset 0 -0.75pt 0 var(--border); }
  .dtbl tfoot .tot-row td { padding:7pt 6pt; background:var(--primary-tint); font-weight:700;
    box-shadow: inset 0 1.5pt 0 var(--text); }
  .dtbl tfoot .tot-row td:first-child { border-radius:3pt 0 0 3pt; }
  .dtbl tfoot .tot-row td:last-child  { border-radius:0 3pt 3pt 0; }
  .dtbl .anom td { background:var(--destructive-bg) !important; }
  .dtbl .day-sub-total td { background:var(--primary-tint); font-size:7.8pt; font-style:italic; }
  .anom-lbl { color:var(--destructive); font-size:7.5pt; font-weight:600; }

  /* ── Utils ── */
  .center { text-align:center; }
  .right  { text-align:right; }
  .bold   { font-weight:700; }
  .small  { font-size:7.8pt; }
  .mono   { font-family:'JetBrains Mono','Courier New',monospace; font-size:7.5pt; }

  /* ── Badge: straordinario (informativo) / pausa pranzo (informativo) ── */
  .ot-badge, .lunch-badge {
    display:inline-block; font-size:5.8pt; font-weight:600;
    border-radius:2.5pt; padding:1.5pt 4pt; margin-left:3pt; white-space:nowrap;
  }
  .ot-badge    { background:var(--primary-tint); color:var(--primary); }
  .lunch-badge { background:var(--warning-bg);   color:var(--warning); }
  .ot-row td   { background:var(--primary-tint) !important; }

  /* ── Signature block ── */
  .sig-section { margin-top:18pt; break-inside:avoid; page-break-inside:avoid; }
  .sig-grid { display:grid; grid-template-columns:1fr 1fr; gap:12mm; margin-top:8pt; }
  .sig-col  { font-size:8pt; color:var(--text); }
  .sig-role { font-size:6.5pt; font-weight:700; text-transform:uppercase;
    letter-spacing:0.5pt; color:var(--muted); margin-bottom:12mm; }
  .sig-line { border-bottom:0.75pt solid var(--border-strong); margin-bottom:4pt; }
  .sig-lbl  { font-size:6.5pt; color:var(--muted-2); }

  /* ── Footer note ── */
  .footer-note {
    margin-top:18pt; padding-top:8pt; border-top:0.75pt solid var(--border);
    font-size:7.3pt; color:var(--muted-2); text-align:center;
  }
</style>
</head>
<body>
<div class="doc">

  <!-- Intestazione -->
  <div class="doc-eyebrow">Report ore lavorate</div>
  <div class="doc-title">Report Ore Lavorate</div>
  <div class="doc-title-rule"></div>

  <div class="meta-grid">
    <div><div class="meta-k">Azienda</div><div class="meta-v">${esc(company.name || '—')}</div></div>
    <div><div class="meta-k">Cantiere</div><div class="meta-v">${esc(site.name)}</div></div>
    <div><div class="meta-k">Periodo</div><div class="meta-v">${esc(period.formatted)}</div></div>
    <div><div class="meta-k">Generato il</div><div class="meta-v">${genStr}</div></div>
    ${site.address ? `<div><div class="meta-k">Indirizzo</div><div class="meta-v">${esc(site.address)}</div></div>` : ''}
    ${totals.grand_lunch_break_minutes > 0 ? `<div><div class="meta-k">Pausa pranzo</div><div class="meta-v">−${fmtDuration(totals.grand_lunch_break_minutes)} detratti automaticamente</div></div>` : ''}
  </div>

  <!-- Summary -->
  <div class="section-hdr">Riepilogo per lavoratore</div>
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
  <div class="section-hdr">Dettaglio per lavoratore</div>
  ${workerSections}

  <div class="footer-note">
    Documento generato da Palladia · ${genStr} · Dati raccolti tramite badge digitale con verifica GPS
  </div>

  <!-- Firme -->
  <div class="sig-section">
    <div class="section-hdr">Attestazione e firme</div>
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
  // Redesign F-154 (AUDIT.md, 2026-09-08): stessa palette del PDF (mockup
  // approvato) — ExcelJS non incorpora font, quindi Plus Jakarta Sans
  // tornerebbe al font di sistema su un PC che non lo ha installato
  // (praticamente ogni commercialista/ASL): Calibri, il default più diffuso.
  const FONT           = 'Calibri';
  const PRIMARY        = '22384F';  // blu Palladia — intestazioni, totali
  const PRIMARY_TINT   = 'EEF2F6';  // straordinario (informativo), riga totale
  const TEXT           = '1A1714';
  const MUTED          = '7A736A';
  const WHITE          = 'FFFFFF';
  const WARNING        = 'A8672A';  // pausa pranzo (informativo)
  const WARNING_BG     = 'FBF3E8';
  const DESTRUCTIVE    = 'A8453B';  // vere anomalie
  const DESTRUCTIVE_BG = 'FBF0EE';
  const GRAY           = 'F7F5F1';  // alternating row
  const TOTAL_BG       = PRIMARY_TINT;

  function headerCell(ws, row, col, value, width) {
    const cell = ws.getCell(row, col);
    cell.value = value;
    cell.font  = { bold: true, color: { argb: WHITE }, name: FONT, size: 10 };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRIMARY } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
    cell.border = {
      top: { style: 'thin', color: { argb: PRIMARY } },
      bottom: { style: 'thin', color: { argb: PRIMARY } },
      left: { style: 'thin', color: { argb: PRIMARY } },
      right: { style: 'thin', color: { argb: PRIMARY } },
    };
    if (width) ws.getColumn(col).width = width;
  }

  function dataCell(cell, value, opts = {}) {
    cell.value = value;
    cell.font  = { name: FONT, size: 10, bold: opts.bold || false, color: { argb: opts.color || TEXT } };
    if (opts.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
    cell.alignment = { vertical: 'middle', horizontal: opts.align || 'left', wrapText: false };
    if (opts.border) {
      cell.border = { bottom: { style: 'thin', color: { argb: 'E7E2D8' } } };
    }
    if (opts.numFmt) cell.numFmt = opts.numFmt;
  }

  function metaRow(ws, label, value) {
    const r = ws.addRow([label, value]);
    r.getCell(1).font = { name: FONT, size: 10, bold: true, color: { argb: MUTED } };
    r.getCell(2).font = { name: FONT, size: 10, color: { argb: TEXT } };
    r.height = 16;
  }

  // ── Sheet 1: Riepilogo ────────────────────────────────────────────────────
  const ws1 = wb.addWorksheet('Riepilogo');
  ws1.properties.defaultRowHeight = 18;

  // Title
  ws1.mergeCells('A1:E1');
  const titleCell = ws1.getCell('A1');
  titleCell.value = 'PALLADIA — Report Ore Lavorate';
  titleCell.font  = { name: FONT, size: 16, bold: true, color: { argb: PRIMARY } };
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
      bg: w.overtime_minutes > 0 ? PRIMARY_TINT : bg,
      border: true, align: 'center',
      color: w.overtime_minutes > 0 ? PRIMARY : MUTED,
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
    cell.font  = { name: FONT, size: 10, bold: true, color: { argb: WHITE } };
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRIMARY } };
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
        const bg = e.anomaly ? DESTRUCTIVE_BG : (d.is_overtime ? PRIMARY_TINT : (altIdx % 2 === 1 ? GRAY : null));
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
          bg: e.lunch_break_minutes > 0 ? WARNING_BG : bg, border: true, align: 'center',
          color: e.lunch_break_minutes > 0 ? WARNING : MUTED,
        });
        dataCell(r.getCell(9), e.hours_str, { bg, border: true, align: 'right', bold: !e.anomaly });
        dataCell(r.getCell(10), toDecimalHours(e.minutes), { bg, border: true, align: 'right', numFmt: '0.00' });
        dataCell(r.getCell(11), e.anomaly || '', {
          bg, border: true,
          color: e.anomaly ? DESTRUCTIVE : TEXT,
          bold: !!e.anomaly,
        });
      }
      // Sub-total for multi-interval days
      if (d.entries.length > 1) {
        const r = ws2.addRow([]);
        r.height = 16;
        for (let c = 1; c <= 11; c++) {
          r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_BG } };
          r.getCell(c).font = { name: FONT, size: 9, italic: true, color: { argb: TEXT } };
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
      sr.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRIMARY } };
      sr.getCell(c).font = { name: FONT, size: 10, bold: true, color: { argb: WHITE } };
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
      const bg = idx % 2 === 1 ? 'FDF7F6' : DESTRUCTIVE_BG;
      dataCell(r.getCell(1), w.full_name,    { bg, border: true });
      dataCell(r.getCell(2), w.fiscal_code,  { bg, border: true, align: 'center' });
      dataCell(r.getCell(3), d.date_formatted, { bg, border: true, align: 'center' });
      dataCell(r.getCell(4), e.entry_time || '—', { bg, border: true, align: 'center' });
      dataCell(r.getCell(5), e.exit_time  || '—', { bg, border: true, align: 'center' });
      dataCell(r.getCell(6), e.anomaly,     { bg, border: true, bold: true, color: DESTRUCTIVE });
    });

    ws3.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { buildWorkerHoursReport, generateWorkerHoursPdfHtml, generateWorkerHoursXlsx, fmtDuration };
