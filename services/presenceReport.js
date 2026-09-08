'use strict';
/**
 * services/presenceReport.js
 *
 * Data layer + HTML template per "Registro Presenze Cantiere".
 * Stessa architettura PDF del POS:
 *   - @page { margin: 26mm 0 24mm 0 }  ←→  Puppeteer margin top:26mm / bottom:24mm
 *   - .doc { padding: 0 16mm }          ←→  allineato ai template H/F
 *   - displayHeaderFooter: true         →   Chrome riserva le bande, zero overlay
 *
 * Export pubblici:
 *   buildDailyPresenceSummary(siteId, companyId, from, to) → Promise<ReportData>
 *   generatePresenceReportHtml(data)                       → string (HTML completo)
 */

const crypto   = require('crypto');
const supabase = require('../lib/supabase');
const { pairLogsByDay, flattenDayLogs, shiftDateStr, resolveLunchBreakConfig, applyLunchBreak } = require('../lib/presencePairing');

// Soglia GPS (stessa del backend punch)
const GPS_MAX_ACCURACY_M = (() => {
  const v = Number(process.env.GPS_MAX_ACCURACY_M);
  return Number.isFinite(v) && v > 0 ? v : 80;
})();

// ── HTML escape ───────────────────────────────────────────────────────────────

// Etichette brevi per la colonna "Metodo" — F-153 (AUDIT.md): il valore
// grezzo (es. "worker_self_punch", "auto_exit_stale_before_reopen") in una
// colonna di soli 9mm andava a capo carattere per carattere ("work/er_s/
// elf_p/unch"), illeggibile in un documento ufficiale. Il dettaglio completo
// resta comunque disponibile nella colonna Anomalie per i metodi non standard.
const SHORT_METHOD_LABEL = {
  worker_self_punch:             'Badge',
  personal_phone:                'Badge',
  capocantiere_action:           'Capocant.',
  admin_manual_correction:       'Manuale',
  auto_exit_on_site_change:      'Auto',
  auto_exit_stale_before_reopen: 'Auto',
  ladia_action:                  'Auto (IA)',
  soft_delete:                   'Eliminato',
};
function shortMethodLabel(method) {
  return SHORT_METHOD_LABEL[method] || method;
}

// Detrazione pausa pranzo automatica è un'informazione di routine, non un
// problema — badge blu invece dell'ambra/rosso riservato alle vere anomalie
// (uscita mancante, GPS impreciso, ecc.) — F-154 (AUDIT.md, redesign PDF).
function anomalyBadgeClass(label) {
  return label.startsWith('Pausa pranzo automatica') ? 'badge-info' : 'badge-anom';
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Timezone helpers — TUTTE le operazioni data/ora usano Europe/Rome ─────────

/**
 * ISO timestamp → "HH:MM"  (Europe/Rome)
 * Usato per le colonne Entrata/Uscita.
 */
function formatTimeRome(ts) {
  return new Date(ts).toLocaleTimeString('it-IT', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome'
  });
}

// ── Calculation helpers ───────────────────────────────────────────────────────

// YYYY-MM-DD → "gg/mm/AAAA"  (stringa, non timestamp — nessuna conversione tz)
function fmtDisplayDate(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Ore decimali → "8h 30m" / "2h" / "45m" / "—"
 * Converte prima in minuti interi per evitare problemi floating-point:
 * es. 0.9999999h → 59.99994m → Math.round → 60 → 1h 0m (non "0h 60m").
 */
function fmtHours(h) {
  if (h == null || h < 0) return '—';
  const totalMins = Math.round(h * 60);   // ← totale in minuti, senza floating drift
  const hh = Math.floor(totalMins / 60);
  const mm = totalMins % 60;
  if (hh === 0) return `${mm}m`;
  if (mm === 0) return `${hh}h`;
  return `${hh}h ${mm}m`;
}

// Ore totali per il riepilogo cover/card (stessa logica, accetta totalHours grande)
function fmtTotalHours(h) {
  if (h <= 0) return '0h';
  const totalMins = Math.round(h * 60);
  const hh = Math.floor(totalMins / 60);
  const mm = totalMins % 60;
  return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`;
}

/**
 * Media aritmetica di un array di numeri, arrotondata all'intero.
 * Restituisce null se l'array è vuoto o tutti null.
 */
function avg(arr) {
  if (!arr || arr.length === 0) return null;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

/**
 * Deduplicazione anomalie con conteggio: ["A","A","B"] → ["A (×2)","B"]
 * Preserva l'ordine di prima occorrenza.
 */
function formatAnomalies(list) {
  if (list.length === 0) return [];
  const counts = new Map();
  for (const a of list) counts.set(a, (counts.get(a) || 0) + 1);
  return Array.from(counts.entries()).map(([name, n]) => n > 1 ? `${name} (×${n})` : name);
}

// ── summarizeDay ──────────────────────────────────────────────────────────────
/**
 * Riassume un giorno già accoppiato da pairLogsByDay() (lib/presencePairing.js):
 * ore totali, prima entrata/ultima uscita, medie GPS, anomalie.
 *
 * Il pairing ENTRY/EXIT avviene PRIMA (sull'intero stream cronologico del
 * lavoratore, cross-giorno) — qui si riassume solo il risultato già assegnato
 * a questo giorno Rome. Questo è ciò che risolve i turni a cavallo di
 * mezzanotte: una coppia 22:00→06:00 arriva già come un'unica coppia valida
 * su un solo giorno, non come due anomalie separate.
 *
 * @param {{pairs, orphanEntries, orphanExits}} dayBucket  Da pairLogsByDay()
 * @param {number|null} geofenceRadius  geofence_radius_m del cantiere
 * @param {{minutes:number, thresholdMinutes:number}} [lunchConfig]  Da resolveLunchBreakConfig() — F-152
 * @returns {{
 *   firstEntry:      string|null,   // "HH:MM" — minimo tra gli ENTRY del giorno
 *   lastExit:        string|null,   // "HH:MM" — massimo tra gli EXIT del giorno
 *   hoursTotal:      number,        // somma ore coppie valide (al netto pausa pranzo), 2 decimali
 *   lunchBreakMinutes: number,      // minuti di pausa pranzo detratti automaticamente
 *   intervalsCount:  number,        // numero coppie valide (ENTRY+EXIT)
 *   avgDist:         number|null,   // media distance_m, arrotondata intero
 *   avgAcc:          number|null,   // media gps_accuracy_m, arrotondata intero
 *   anomalies:       string[]       // anomalie formattate con conteggio
 * }}
 */
function summarizeDay(dayBucket, geofenceRadius, lunchConfig) {
  const { pairs, orphanEntries, orphanExits } = dayBucket;
  const dayLogs = flattenDayLogs(dayBucket);

  // Anomalie strutturali in ordine cronologico (stesso ordine del vecchio
  // scan sequenziale, per compatibilità di lettura)
  const orphanEvents = [
    ...orphanEntries.map(l => ({ log: l, label: 'Uscita mancante' })),
    ...orphanExits.map(l => ({ log: l, label: 'Uscita senza entrata' })),
  ].sort((a, b) => a.log.timestamp_server.localeCompare(b.log.timestamp_server));
  const rawAnomalies = orphanEvents.map(oe => oe.label);

  // Ore totali = somma coppie valide al netto della pausa pranzo automatica
  // (F-152, AUDIT.md), arrotondata a 2 decimali.
  const lunchResults = applyLunchBreak(pairs, lunchConfig);
  const lunchBreakMinutes = lunchResults.reduce((s, r) => s + (r.lunchBreakMinutes || 0), 0);
  if (lunchBreakMinutes > 0) rawAnomalies.push(`Pausa pranzo automatica: −${lunchBreakMinutes}m`);
  const sumH = lunchResults.reduce((s, r) => s + r.minutes / 60, 0);
  const hoursTotal = Math.round(sumH * 100) / 100;

  // Prima entrata = min tra ENTRY delle coppie + ENTRY orfani del giorno
  // Ultima uscita = max tra EXIT delle coppie + EXIT orfani del giorno
  const entryLogs = [...pairs.map(p => p.entry), ...orphanEntries];
  const exitLogs   = [...pairs.map(p => p.exit),  ...orphanExits];

  const firstEntry = entryLogs.length > 0
    ? formatTimeRome(entryLogs.reduce((a, b) => a.timestamp_server < b.timestamp_server ? a : b).timestamp_server)
    : null;
  const lastExit   = exitLogs.length > 0
    ? formatTimeRome(exitLogs.reduce((a, b) => a.timestamp_server > b.timestamp_server ? a : b).timestamp_server)
    : null;

  // Medie su TUTTI i log del giorno (massima trasparenza, incluse coppie parziali)
  const allDists = dayLogs.map(l => l.distance_m).filter(v => v != null);
  const allAccs  = dayLogs.map(l => l.gps_accuracy_m).filter(v => v != null);
  const avgDist  = avg(allDists);
  const avgAcc   = avg(allAccs);

  // Anomalie qualità (aggiunte dopo le strutturali per preservare ordine di lettura)
  if (avgAcc != null && avgAcc > GPS_MAX_ACCURACY_M)
    rawAnomalies.push('Precisione GPS bassa');
  if (avgDist != null && geofenceRadius != null && avgDist > geofenceRadius * 0.9)
    rawAnomalies.push('Vicino limite area');

  // Distinct methods used in this day's logs (e.g. ['scan', 'admin'])
  const methods = [...new Set(dayLogs.map(l => l.method).filter(Boolean))];

  return {
    firstEntry,
    lastExit,
    hoursTotal,
    lunchBreakMinutes,
    intervalsCount: pairs.length,
    avgDist,
    avgAcc,
    methods,
    anomalies: formatAnomalies(rawAnomalies)
  };
}

// ── buildDailyPresenceSummary ─────────────────────────────────────────────────
/**
 * Recupera i log di presenza per siteId+companyId nel range [from, to]
 * e li elabora in coppie ENTRY/EXIT con calcolo ore, medie e anomalie.
 *
 * @param {string} siteId     UUID del cantiere
 * @param {string} companyId  UUID dell'azienda (sicurezza: sempre dal JWT)
 * @param {string} from       YYYY-MM-DD inizio periodo
 * @param {string} to         YYYY-MM-DD fine periodo
 * @returns {Promise<Object>} dati strutturati pronti per il template HTML
 */
async function buildDailyPresenceSummary(siteId, companyId, from, to) {
  // 1. Cantiere (verifica ownership + dati display + config pausa pranzo)
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, address, geofence_radius_m, company_id, lunch_break_minutes, lunch_break_threshold_hours')
    .eq('id', siteId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (siteErr) throw new Error('DB_ERROR: ' + siteErr.message);
  if (!site)   { const e = new Error('SITE_NOT_FOUND'); e.status = 404; throw e; }

  // 2. Azienda (nome + default pausa pranzo, ereditato dal cantiere senza override)
  const { data: company, error: compErr } = await supabase
    .from('companies')
    .select('id, name, lunch_break_minutes, lunch_break_threshold_hours')
    .eq('id', companyId)
    .maybeSingle();

  if (compErr) throw new Error('DB_ERROR: ' + compErr.message);

  const lunchConfig = resolveLunchBreakConfig(company, site);

  // 3. Log nel periodo (includi tutto il giorno finale in UTC)
  // Limite: 50k record (90gg × 500 lavoratori × 4 timbrature ≈ 180k max teorico;
  // in pratica 50k copre la quasi totalità dei casi reali).
  // Se superato: report parziale + warning nel payload.
  // Finestra allargata di 1 giorno intero su ciascun lato (oltre al consueto
  // +02:00/+01:00 invece di Z): serve a poter accoppiare correttamente anche
  // un turno a cavallo del bordo from/to, non solo della mezzanotte interna al
  // periodo — vedi lib/presencePairing.js. Le righe fuori [from,to] dopo il
  // pairing vengono scartate più sotto.
  const LOGS_LIMIT  = 50_000;
  const fetchFrom    = shiftDateStr(from, -1);
  const fetchTo      = shiftDateStr(to, 1);
  const { data: logs, error: logsErr } = await supabase
    .from('presence_logs')
    .select(`
      id, event_type, timestamp_server, distance_m, gps_accuracy_m, worker_id, method,
      worker:workers (id, full_name, fiscal_code)
    `)
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .gte('timestamp_server', `${fetchFrom}T00:00:00+02:00`)
    .lte('timestamp_server', `${fetchTo}T23:59:59.999+01:00`)
    .order('worker_id', { ascending: true })
    .order('timestamp_server', { ascending: true })
    .limit(LOGS_LIMIT);

  if (logsErr) throw new Error('DB_ERROR: ' + logsErr.message);
  const logsLimitReached = (logs || []).length === LOGS_LIMIT;

  // 4. Raggruppa per worker (stream cronologico, cross-giorno) → pairing →
  //    filtro dei giorni al di fuori di [from,to]
  const byWorker = new Map();
  for (const log of (logs || [])) {
    if (!log.worker) continue;
    const wid = log.worker_id;
    if (!byWorker.has(wid)) byWorker.set(wid, { worker: log.worker, logs: [] });
    byWorker.get(wid).logs.push(log);
  }

  const rows         = [];
  let   totalHours   = 0;
  const workerIds    = new Set();
  let   totalPunches = 0;

  for (const [, wData] of byWorker) {
    const dayMap = pairLogsByDay(wData.logs);   // ← accoppia PRIMA, sull'intero stream

    for (const [dateKey, dayBucket] of dayMap) {
      if (dateKey < from || dateKey > to) continue;   // fuori dal periodo richiesto

      const result = summarizeDay(dayBucket, site.geofence_radius_m, lunchConfig);
      const dayLogCount = dayBucket.pairs.length * 2
        + dayBucket.orphanEntries.length + dayBucket.orphanExits.length;
      if (dayLogCount === 0) continue;

      workerIds.add(wData.worker.id);
      totalPunches += dayLogCount;
      totalHours   += result.hoursTotal;

      rows.push({
        dateKey,
        date:            fmtDisplayDate(dateKey),
        worker_name:     wData.worker.full_name,
        fiscal_code:     wData.worker.fiscal_code,
        first_entry:     result.firstEntry,       // "HH:MM" | null
        last_exit:       result.lastExit,          // "HH:MM" | null
        hours_total:     result.hoursTotal,        // 2 decimali
        intervals_count: result.intervalsCount,    // n. coppie valide
        avg_distance_m:  result.avgDist,
        avg_accuracy_m:  result.avgAcc,
        methods:         result.methods,           // e.g. ['scan', 'admin']
        anomalies:       result.anomalies          // formattate con dedup/count
      });
    }
  }

  // Ordina: data ↑, lavoratore ↑
  rows.sort((a, b) =>
    a.dateKey.localeCompare(b.dateKey) || a.worker_name.localeCompare(b.worker_name)
  );

  return {
    site: {
      id:                site.id,
      name:              site.name,
      address:           site.address,
      geofence_radius_m: site.geofence_radius_m
    },
    company:            { name: company?.name || '' },
    period:             { from, to },
    generated_at:       new Date().toISOString(),
    doc_id:             crypto.randomUUID(),
    total_workers:      workerIds.size,
    total_hours:        Math.round(totalHours * 100) / 100,   // 2 decimali
    total_punches:      totalPunches,
    anomalies_count:    rows.filter(r => r.anomalies.length > 0).length,
    max_accuracy_m:     GPS_MAX_ACCURACY_M,
    logs_limit_reached: logsLimitReached,   // true se troncato a 50k
    rows
  };
}

// ── generatePresenceReportHtml ────────────────────────────────────────────────
/**
 * Genera l'HTML completo del Registro Presenze, identico per architettura
 * CSS/Puppeteer al PDF POS (stessi margini, stessa struttura .doc, stesso H/F).
 *
 * @param {Object} data  Valore restituito da buildDailyPresenceSummary()
 * @returns {string}     HTML pronto per rendererPool.render()
 */
function generatePresenceReportHtml(data) {
  const {
    site, company, period, generated_at, doc_id,
    total_workers, total_hours, total_punches, anomalies_count,
    max_accuracy_m, rows
  } = data;

  const periodStr   = period.from === period.to
    ? fmtDisplayDate(period.from)
    : `${fmtDisplayDate(period.from)} — ${fmtDisplayDate(period.to)}`;

  const genDateStr  = new Date(generated_at).toLocaleString('it-IT', {
    timeZone: 'Europe/Rome', dateStyle: 'long', timeStyle: 'short'
  });

  const totalHoursStr = fmtTotalHours(total_hours);

  // ── Righe tabella ──────────────────────────────────────────────────────────
  let tableRowsHtml = '';
  let prevDateKey   = null;

  if (rows.length === 0) {
    tableRowsHtml = `
      <tr>
        <td colspan="11" style="text-align:center;color:#888888;padding:16pt 0;font-size:9pt;">
          Nessuna presenza registrata nel periodo selezionato.
        </td>
      </tr>`;
  } else {
    for (const row of rows) {
      const isNewDate = row.dateKey !== prevDateKey;
      prevDateKey     = row.dateKey;

      const anomalyHtml = row.anomalies.length > 0
        ? row.anomalies.map(a => `<span class="${anomalyBadgeClass(a)}">${esc(a)}</span>`).join(' ')
        : '<span class="td-ok">✓</span>';

      // Prima entrata — null se nessun ENTRY (solo EXIT orfani nel giorno)
      const entryStr = row.first_entry
        ? esc(row.first_entry)
        : '<span class="miss">—</span>';

      // Ultima uscita — null se nessun EXIT nel giorno
      const exitStr  = row.last_exit
        ? esc(row.last_exit)
        : '<span class="miss">—</span>';

      // Ore: solo se ci sono coppie valide; 0 se ci sono solo anomalie
      const hoursStr = row.intervals_count > 0
        ? `<strong>${esc(fmtHours(row.hours_total))}</strong>`
        : '<span class="miss">—</span>';

      // N. intervalli validi (ENTRY+EXIT)
      const intStr = row.intervals_count > 0
        ? String(row.intervals_count)
        : '<span class="miss">0</span>';

      const distStr    = row.avg_distance_m != null ? `${row.avg_distance_m}m` : '—';
      const accStr     = row.avg_accuracy_m  != null ? `±${row.avg_accuracy_m}m` : '—';
      const methodsStr = row.methods && row.methods.length > 0
        ? esc(row.methods.map(shortMethodLabel).join(', '))
        : '—';

      const trClass = [
        row.anomalies.length > 0 ? 'tr-anom'   : '',
        isNewDate                ? 'tr-newdate' : ''
      ].filter(Boolean).join(' ');

      tableRowsHtml += `
      <tr class="${trClass}">
        <td class="td-date">${esc(row.date)}</td>
        <td class="td-name">${esc(row.worker_name)}</td>
        <td class="td-cf">${esc(row.fiscal_code)}</td>
        <td class="td-time">${entryStr}</td>
        <td class="td-time">${exitStr}</td>
        <td class="td-num">${hoursStr}</td>
        <td class="td-num">${intStr}</td>
        <td class="td-num">${distStr}</td>
        <td class="td-num">${accStr}</td>
        <td class="td-num" style="font-size:7.5pt;color:#555555;">${methodsStr}</td>
        <td class="td-anom-cell">${anomalyHtml}</td>
      </tr>`;
    }
  }

  // ── Sezione anomalie (solo se presenti) ────────────────────────────────────
  const anomRows = rows.filter(r => r.anomalies.length > 0);
  const anomSectionHtml = anomRows.length === 0 ? '' : `
  <div class="section-title">Anomalie rilevate (${anomRows.length} sessioni)</div>
  <div class="anom-box">
    <p style="font-size:8.5pt;color:#555555;margin-bottom:6pt;">
      Le seguenti sessioni presentano condizioni da verificare. Le righe corrispondenti
      nella tabella sono evidenziate in arancione.
    </p>
    <ul class="anom-list">
      ${anomRows.slice(0, 40).map(r => `
        <li>
          <strong>${esc(r.date)} — ${esc(r.worker_name)}</strong>:
          ${r.anomalies.map(a => esc(a)).join(', ')}
        </li>`).join('')}
      ${anomRows.length > 40
        ? `<li style="color:#888888;">… e altre ${anomRows.length - 40} anomalie</li>`
        : ''}
    </ul>
  </div>`;

  // ── HTML finale ────────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
/* ═══════════════════════════════════════════════════════════════════
   PALLADIA PDF — Registro Presenze Cantiere
   Redesign F-154 (AUDIT.md, 2026-09-08): stile/font/colori reali di
   Palladia (Plus Jakarta Sans, palette dell'app) al posto del navy/Arial
   generico usato finora — stessa direzione già approvata come mockup.
   Architettura Puppeteer invariata (displayHeaderFooter:true):
     @page { margin: 26mm 0 24mm 0 } ↔ Puppeteer top:26mm / bottom:24mm
     .doc { padding: 0 16mm }        ↔ allineato ai template H/F
   ═══════════════════════════════════════════════════════════════════ */

:root {
  --primary: #22384F; --primary-tint: #EEF2F6;
  --text: #1A1714; --muted: #7A736A; --muted-2: #9C948A;
  --border: #E7E2D8; --border-strong: #D8D1C3;
  --success: #4A7358; --success-bg: #EEF3EE;
  --warning: #A8672A; --warning-bg: #FBF3E8;
  --destructive: #A8453B; --destructive-bg: #FBF0EE;
}

/* ── RESET ──────────────────────────────────────────────────────────── */
*, *::before, *::after {
  box-sizing: border-box; margin: 0; padding: 0;
  word-break: break-word; overflow-wrap: break-word; min-width: 0;
}
html, body {
  margin: 0; padding: 0;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
body {
  font-family: 'Plus Jakarta Sans', Arial, Helvetica, sans-serif;
  font-size: 9.5pt; color: var(--text); line-height: 1.55; background: #FFFFFF;
}
/* color esplicito su table: non sempre ereditato dal genitore in ogni
   motore di rendering (verificato in fase di mockup) — meglio non fare
   affidamento sulla sola ereditarietà per un elemento così centrale. */
table { color: var(--text); }
.doc { width: 100%; max-width: 100%; box-sizing: border-box; padding: 0 16mm; }

/* ── INTESTAZIONE ───────────────────────────────────────────────────── */
.doc-eyebrow {
  display: inline-flex; align-items: center; gap: 6pt;
  font-size: 7.5pt; font-weight: 700; letter-spacing: 0.9pt; text-transform: uppercase;
  color: var(--primary); background: var(--primary-tint);
  padding: 3pt 7pt 3pt 5pt; border-radius: 2.5pt; margin-bottom: 8pt;
}
.doc-title { font-size: 19pt; font-weight: 700; letter-spacing: -0.3pt; color: var(--text); line-height: 1.2; margin-bottom: 3pt; }
.doc-title-rule { width: 22pt; height: 2.5pt; background: var(--primary); border-radius: 2pt; margin: 8pt 0 12pt; }

.meta-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 8pt 10pt;
  margin-bottom: 14pt; padding-bottom: 12pt; border-bottom: 0.75pt solid var(--border);
}
.meta-grid.two-col { grid-template-columns: 1fr 1fr; }
.meta-k { font-size: 6.5pt; font-weight: 700; letter-spacing: 0.6pt; text-transform: uppercase; color: var(--muted-2); margin-bottom: 1.5pt; }
.meta-v { font-size: 9.5pt; font-weight: 600; color: var(--text); line-height: 1.35; }

/* ── SECTION LABEL (sostituisce il blocco pieno navy) ──────────────── */
.section-title {
  display: flex; align-items: center; gap: 7pt;
  font-size: 7.5pt; font-weight: 700; letter-spacing: 0.7pt; text-transform: uppercase;
  color: var(--muted); margin-top: 16pt; margin-bottom: 8pt;
}
.section-title::after { content: ""; flex: 1; height: 0.75pt; background: var(--border); }
.section-title:first-of-type { margin-top: 0; }

/* ── CARDS RIEPILOGO ────────────────────────────────────────────────── */
.summary-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 6pt; margin-bottom: 14pt;
}
.summary-card {
  border: 0.75pt solid var(--border); border-radius: 4pt;
  padding: 8pt 9pt;
}
.sc-num   { font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 15pt; font-weight: 600; color: var(--text); line-height: 1; margin-bottom: 4pt; }
.sc-label { font-size: 6.5pt; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5pt; font-weight: 600; }
.sc-warn  { border-color: var(--warning); background: var(--warning-bg); }
.sc-warn .sc-num { color: var(--warning); }
.sc-ok   .sc-num { color: var(--success); }

/* ── TABELLA PRESENZE ───────────────────────────────────────────────── */
/*
  Larghezza contenuto A4 = 210mm − 2×16mm = 178mm
  11 colonne (F-153, AUDIT.md: Metodo era un 12° valore in mm fisso NON
  incluso in questo budget — le percentuali sotto sommavano già a 100% da
  sole, quindi il totale reale superava il 100% e in table-layout:fixed il
  browser comprimeva le colonne in modo non uniforme: la colonna Data,
  già stretta e con white-space:nowrap, finiva per traboccare visibilmente
  dentro la colonna Lavoratore successiva):
    Data 12% · Lavoratore 17% · C.Fiscale 15% · P.Entrata 7% ·
    U.Uscita 7% · Ore 7% · N.Int 4% · Dist 5% · GPS 5% · Metodo 7% ·
    Anomalie 14% = 100%
*/
.presence-table {
  width: 100%; table-layout: fixed; border-collapse: collapse;
  font-size: 7.8pt; margin-bottom: 14pt;
}
.presence-table thead th {
  padding: 0 4pt 6pt 0; font-size: 6.5pt; font-weight: 700;
  letter-spacing: 0.4pt; text-transform: uppercase; color: var(--muted);
  text-align: left; border-bottom: 1.5pt solid var(--text);
}
/* box-shadow invece di border-bottom sulle celle: sotto scaling frazionario
   Chromium arrotonda un 1px border in modo diverso per ogni cella quando le
   altezze di riga differiscono — risultato osservato in fase di mockup: una
   riga corta e più scura solo sotto la cella più alta. Un box-shadow non
   collassa mai in questo modo, indipendentemente dall'altezza delle celle. */
.presence-table tbody td {
  padding: 5.5pt 4pt 5.5pt 0; vertical-align: top; line-height: 1.4;
  box-shadow: inset 0 -0.75pt 0 var(--border);
}
.tr-newdate td { box-shadow: inset 0 1.5pt 0 var(--border-strong), inset 0 -0.75pt 0 var(--border); }
.tr-anom td    { background: var(--destructive-bg) !important; }

/* Larghezze colonne (table-layout:fixed) */
.col-date   { width: 12%; }
.col-name   { width: 17%; }
.col-cf     { width: 15%; }
.col-time   { width:  7%; }
.col-ore    { width:  7%; }
.col-nint   { width:  4%; }
.col-dist   { width:  5%; }
.col-gps    { width:  5%; }
.col-metodo { width:  7%; }
.col-anom   { width: 14%; }

.td-date  { font-weight: 600; color: var(--text); white-space: nowrap; }
.td-name  { font-weight: 500; }
.td-cf    { font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 6.8pt; color: var(--muted); letter-spacing: -0.1pt; }
.td-time  { text-align: center; white-space: nowrap; font-variant-numeric: tabular-nums; }
.td-num   { text-align: center; }
.td-anom-cell { }

.miss       { color: var(--destructive); font-weight: 700; }
.td-ok      { color: var(--success); font-size: 9pt; }
.badge-anom, .badge-info {
  display: inline-block; font-size: 5.8pt; font-weight: 600;
  border-radius: 2.5pt; padding: 1.5pt 4pt; margin: 1pt 2pt 1pt 0; white-space: nowrap;
}
.badge-anom { background: var(--destructive-bg); color: var(--destructive); }
.badge-info { background: var(--primary-tint);    color: var(--primary); }

/* ── SEZIONE ANOMALIE ───────────────────────────────────────────────── */
.anom-box {
  background: var(--warning-bg); border: 0.75pt solid var(--warning); border-radius: 4pt;
  padding: 9pt 10pt; margin-bottom: 14pt;
}
.anom-list {
  font-size: 7.5pt; color: var(--text); padding-left: 13pt; line-height: 1.7;
}
.anom-list li { margin-bottom: 2pt; }

/* ── DICHIARAZIONE FINALE ───────────────────────────────────────────── */
.declaration {
  margin-top: 4pt;
}
.declaration p { font-size: 7.3pt; color: var(--muted); line-height: 1.65; margin-bottom: 6pt; }
.declaration p strong { color: var(--text); }
.declaration .doc-meta {
  font-size: 6.3pt; color: var(--muted-2); font-family: 'JetBrains Mono', 'Courier New', monospace;
  line-height: 1.7; margin-top: 8pt;
}

/* ── BLOCCO FIRME ───────────────────────────────────────────────────── */
.sig-section { margin-top: 18pt; break-inside: avoid !important; page-break-inside: avoid !important; }
.sig-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; margin-top: 8pt;
}
.sig-col { font-size: 8pt; color: var(--text); }
.sig-role { font-size: 6.5pt; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.5pt; color: var(--muted); margin-bottom: 12mm; }
.sig-line { border-bottom: 0.75pt solid var(--border-strong); margin-bottom: 4pt; }
.sig-lbl  { font-size: 6.5pt; color: var(--muted-2); }

/* ── ANTI-TAGLIO ────────────────────────────────────────────────────── */
h1, h2, h3 { break-after: avoid-page; page-break-after: avoid; }
tr    { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }

/* ══════════════════════════════════════════════════════════════════════
   BLOCCO FINALE — vince su tutto (cascata CSS)
   @page margin DEVE coincidere con Puppeteer margin in makePdfOpts()
   ══════════════════════════════════════════════════════════════════════ */
@page { size: A4; margin: 26mm 0 24mm 0; }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0 !important; padding: 0 !important;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.doc  { width: 100% !important; max-width: 100% !important;
  padding: 0 16mm !important; box-sizing: border-box !important; }
table { width: 100% !important; max-width: 100% !important;
  table-layout: fixed !important; border-collapse: collapse !important; }
th, td { max-width: 100% !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
thead { display: table-header-group; }
tr    { break-inside: avoid; page-break-inside: avoid; }
h1, h2, h3, .section-title { break-after: avoid-page !important; page-break-after: avoid !important; }
.summary-card, .anom-box, .declaration, .sig-section { break-inside: avoid !important; page-break-inside: avoid !important; }
</style>
</head>
<body>
<div class="doc">

  <!-- ══ INTESTAZIONE ═══════════════════════════════════════════════════ -->
  <div class="doc-eyebrow">Registro ufficiale presenze</div>
  <div class="doc-title">Registro Presenze Cantiere</div>
  <div class="doc-title-rule"></div>

  <div class="meta-grid">
    <div><div class="meta-k">Impresa</div><div class="meta-v">${esc(company.name || '—')}</div></div>
    <div><div class="meta-k">Cantiere</div><div class="meta-v">${esc(site.name)}</div></div>
    <div><div class="meta-k">Periodo</div><div class="meta-v">${esc(periodStr)}</div></div>
    <div><div class="meta-k">Generato il</div><div class="meta-v">${esc(genDateStr)}</div></div>
    ${site.address ? `<div style="grid-column:1/-1;"><div class="meta-k">Indirizzo cantiere</div><div class="meta-v">${esc(site.address)}</div></div>` : ''}
  </div>

  <!-- ══ RIEPILOGO ══════════════════════════════════════════════════════ -->
  <div class="summary-grid">
    <div class="summary-card">
      <div class="sc-num">${total_workers}</div>
      <div class="sc-label">Lavoratori coinvolti</div>
    </div>
    <div class="summary-card">
      <div class="sc-num">${total_punches}</div>
      <div class="sc-label">Timbrature registrate</div>
    </div>
    <div class="summary-card">
      <div class="sc-num">${esc(totalHoursStr)}</div>
      <div class="sc-label">Ore lavorate totali</div>
    </div>
    <div class="summary-card ${anomalies_count > 0 ? 'sc-warn' : 'sc-ok'}">
      <div class="sc-num">${anomalies_count}</div>
      <div class="sc-label">Sessioni con anomalie</div>
    </div>
  </div>

  <!-- ══ TABELLA PRESENZE ═══════════════════════════════════════════════ -->
  <div class="section-title">Dettaglio presenze giornaliere</div>
  <table class="presence-table">
    <colgroup>
      <col class="col-date"> <col class="col-name"> <col class="col-cf">
      <col class="col-time"> <col class="col-time"> <col class="col-ore">
      <col class="col-nint"> <col class="col-dist"> <col class="col-gps">
      <col class="col-metodo"> <col class="col-anom">
    </colgroup>
    <thead>
      <tr>
        <th>Data</th>
        <th>Lavoratore</th>
        <th>Codice Fiscale</th>
        <th style="text-align:center;">Entrata</th>
        <th style="text-align:center;">Uscita</th>
        <th style="text-align:center;">Ore</th>
        <th style="text-align:center;">N.</th>
        <th style="text-align:center;">Dist. m</th>
        <th style="text-align:center;">GPS m</th>
        <th style="text-align:center;">Metodo</th>
        <th>Anomalie</th>
      </tr>
    </thead>
    <tbody>${tableRowsHtml}
    </tbody>
  </table>

  ${anomSectionHtml}

  <!-- ══ DICHIARAZIONE ══════════════════════════════════════════════════ -->

  <div class="section-title">Dichiarazione e note sul documento</div>
  <div class="declaration">
    <p>
      Il presente registro è stato generato automaticamente dal sistema Palladia con
      tracciamento geolocalizzato e controllo di prossimità al cantiere. Ogni timbratura
      è verificata server-side mediante geofence GPS
      (raggio configurato: <strong>${site.geofence_radius_m != null ? site.geofence_radius_m + 'm' : 'non configurato'}</strong>)
      e registrata in modo immutabile su database append-only: nessuna modifica o
      cancellazione è consentita post-registrazione a livello di database (trigger PostgreSQL).
    </p>
    <p>
      Il documento attesta la presenza sul cantiere
      "<strong>${esc(site.name)}</strong>" dei lavoratori indicati nel periodo
      <strong>${esc(periodStr)}</strong>. La timbratura avviene tramite dispositivo
      personale del lavoratore. La precisione GPS massima accettata è
      <strong>${max_accuracy_m}m</strong>; le sessioni con precisione superiore
      sono segnalate come anomalia "Precisione GPS bassa".
      Le sessioni senza uscita registrata sono segnalate come "Uscita mancante";
      le uscite senza entrata corrispondente come "Uscita senza entrata".
    </p>
    <p>
      <strong>Timezone:</strong> Europe/Rome — ora locale italiana, ora legale inclusa
      (tutte le date e gli orari nel documento sono espressi in ora italiana).<br>
      <strong>Calcolo ore:</strong> le ore giornaliere sono la somma delle differenze
      tra coppie sequenziali ENTRY/EXIT valide nello stesso giorno. In presenza di
      più intervalli (es. pausa pranzo) ciascuna coppia è calcolata separatamente e
      le ore sommate. Le coppie parziali (ENTRY senza EXIT) non contribuiscono al
      totale ore e sono segnalate come anomalia.<br>
      <strong>Medie distanza e precisione GPS:</strong> calcolate come media aritmetica
      su tutte le timbrature del giorno per quel lavoratore (incluse le coppie parziali),
      arrotondate all'intero più vicino.
    </p>
    <div class="doc-meta">
      ID documento : ${doc_id}<br>
      Timestamp    : ${generated_at}<br>
      Timezone     : Europe/Rome<br>
      Cantiere     : ${esc(site.name)} / ${site.id}<br>
      Impresa      : ${esc(company.name || '—')}<br>
      Sistema      : Palladia — Registro Digitale Presenze v1.0
    </div>
  </div>

  <!-- ══ FIRME ════════════════════════════════════════════════════════ -->
  <div class="sig-section">
    <div class="section-title">Attestazione e firme</div>
    <div class="sig-grid">
      <div class="sig-col">
        <div class="sig-role">Datore di Lavoro / Rappresentante Legale</div>
        <div class="sig-line"></div>
        <div class="sig-lbl">Nome e cognome: _____________________________________</div>
        <br>
        <div class="sig-lbl">Data: _______________________&emsp;Firma: _____________________________________</div>
      </div>
      <div class="sig-col">
        <div class="sig-role">R.S.P.P. — Responsabile Servizio Prevenzione e Protezione</div>
        <div class="sig-line"></div>
        <div class="sig-lbl">Nome e cognome: _____________________________________</div>
        <br>
        <div class="sig-lbl">Data: _______________________&emsp;Firma: _____________________________________</div>
      </div>
    </div>
  </div>

</div><!-- /doc -->
</body>
</html>`;
}

module.exports = { buildDailyPresenceSummary, generatePresenceReportHtml };
