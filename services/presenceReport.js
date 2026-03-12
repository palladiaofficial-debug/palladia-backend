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

// Soglia GPS (stessa del backend punch)
const GPS_MAX_ACCURACY_M = (() => {
  const v = Number(process.env.GPS_MAX_ACCURACY_M);
  return Number.isFinite(v) && v > 0 ? v : 80;
})();

// ── HTML escape ───────────────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Timezone helpers — TUTTE le operazioni data/ora usano Europe/Rome ─────────

/**
 * ISO timestamp → "gg/mm/AAAA"  (Europe/Rome)
 * Usato per le colonne Data nella tabella PDF.
 */
function formatDateRome(ts) {
  return new Date(ts).toLocaleDateString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Rome'
  });
}

/**
 * ISO timestamp → "HH:MM"  (Europe/Rome)
 * Usato per le colonne Entrata/Uscita.
 */
function formatTimeRome(ts) {
  return new Date(ts).toLocaleTimeString('it-IT', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome'
  });
}

/**
 * ISO timestamp → "YYYY-MM-DD"  (Europe/Rome)
 * Chiave per il raggruppamento per giorno.
 * Usa locale sv-SE che produce ISO date nativo senza toISOString()
 * (toISOString() sarebbe sempre UTC, sbagliato dopo le 22/23 in estate/inverno).
 */
function getDateKeyRome(ts) {
  return new Date(ts).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
}

// ── Calculation helpers ───────────────────────────────────────────────────────

// YYYY-MM-DD → "gg/mm/AAAA"  (stringa, non timestamp — nessuna conversione tz)
function fmtDisplayDate(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-');
  return `${d}/${m}/${y}`;
}

// Differenza in ore tra due ISO timestamp (non negativa)
function hoursBetween(entry, exit) {
  return Math.max(0, (new Date(exit) - new Date(entry)) / 3_600_000);
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

// ── pairDayIntervals ──────────────────────────────────────────────────────────
/**
 * Accoppia sequenzialmente ENTRY→EXIT per i log di un singolo lavoratore
 * in un singolo giorno (già ordinati per timestamp_server ascending).
 *
 * Algoritmo lineare O(n):
 *   - ENTRY seguito da EXIT        → coppia valida, ore calcolate
 *   - ENTRY non seguito da EXIT    → coppia incompleta, anomalia "Uscita mancante"
 *   - EXIT senza ENTRY precedente  → anomalia "Uscita senza entrata"
 *
 * Le anomalie strutturali multiple vengono raggruppate con conteggio:
 *   ["Uscita mancante (×2)", "Uscita senza entrata"]
 *
 * Medie distanza e precisione calcolate su TUTTI i log del giorno,
 * non solo sulle coppie valide (per massima trasparenza nell'audit).
 *
 * @param {Array}  dayLogs        Log del giorno, sorted by timestamp_server asc
 * @param {number|null} geofenceRadius  geofence_radius_m del cantiere
 * @returns {{
 *   firstEntry:      string|null,   // "HH:MM" — minimo tra i log ENTRY
 *   lastExit:        string|null,   // "HH:MM" — massimo tra i log EXIT
 *   hoursTotal:      number,        // somma ore coppie valide, 2 decimali
 *   intervalsCount:  number,        // numero coppie valide (ENTRY+EXIT)
 *   avgDist:         number|null,   // media distance_m, arrotondata intero
 *   avgAcc:          number|null,   // media gps_accuracy_m, arrotondata intero
 *   anomalies:       string[]       // anomalie formattate con conteggio
 * }}
 */
function pairDayIntervals(dayLogs, geofenceRadius) {
  const rawAnomalies = [];
  const validPairs   = [];   // { entry, exit } — solo coppie complete

  let i = 0;
  while (i < dayLogs.length) {
    const log = dayLogs[i];

    if (log.event_type === 'ENTRY') {
      const nextLog = i + 1 < dayLogs.length ? dayLogs[i + 1] : null;
      if (nextLog && nextLog.event_type === 'EXIT') {
        // Coppia valida
        validPairs.push({ entry: log, exit: nextLog });
        i += 2;
      } else {
        // ENTRY senza EXIT: anomalia, non inventare orari
        rawAnomalies.push('Uscita mancante');
        i += 1;
      }
    } else {
      // EXIT senza ENTRY precedente (orfana)
      rawAnomalies.push('Uscita senza entrata');
      i += 1;
    }
  }

  // Ore totali = somma coppie valide, arrotondata a 2 decimali
  const sumH = validPairs.reduce(
    (s, p) => s + hoursBetween(p.entry.timestamp_server, p.exit.timestamp_server), 0
  );
  const hoursTotal = Math.round(sumH * 100) / 100;

  // Prima entrata = min di tutti i log ENTRY del giorno
  // Ultima uscita = max di tutti i log EXIT del giorno
  // (indipendente dal pairing — audit mostra quando è fisicamente arrivato/partito)
  const entryLogs = dayLogs.filter(l => l.event_type === 'ENTRY');
  const exitLogs  = dayLogs.filter(l => l.event_type === 'EXIT');

  const firstEntry = entryLogs.length > 0
    ? formatTimeRome(entryLogs[0].timestamp_server)                        // già sorted asc
    : null;
  const lastExit   = exitLogs.length > 0
    ? formatTimeRome(exitLogs[exitLogs.length - 1].timestamp_server)
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
    intervalsCount: validPairs.length,
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
  // 1. Cantiere (verifica ownership + dati display)
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, address, geofence_radius_m, company_id')
    .eq('id', siteId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (siteErr) throw new Error('DB_ERROR: ' + siteErr.message);
  if (!site)   { const e = new Error('SITE_NOT_FOUND'); e.status = 404; throw e; }

  // 2. Azienda
  const { data: company, error: compErr } = await supabase
    .from('companies')
    .select('id, name')
    .eq('id', companyId)
    .maybeSingle();

  if (compErr) throw new Error('DB_ERROR: ' + compErr.message);

  // 3. Log nel periodo (includi tutto il giorno finale in UTC)
  // Limite: 50k record (90gg × 500 lavoratori × 4 timbrature ≈ 180k max teorico;
  // in pratica 50k copre la quasi totalità dei casi reali).
  // Se superato: report parziale + warning nel payload.
  const LOGS_LIMIT = 50_000;
  const { data: logs, error: logsErr } = await supabase
    .from('presence_logs')
    .select(`
      id, event_type, timestamp_server, distance_m, gps_accuracy_m, worker_id, method,
      worker:workers (id, full_name, fiscal_code)
    `)
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .gte('timestamp_server', `${from}T00:00:00.000Z`)
    .lte('timestamp_server', `${to}T23:59:59.999Z`)
    .order('worker_id', { ascending: true })
    .order('timestamp_server', { ascending: true })
    .limit(LOGS_LIMIT);

  if (logsErr) throw new Error('DB_ERROR: ' + logsErr.message);
  const logsLimitReached = (logs || []).length === LOGS_LIMIT;

  // 4. Raggruppa per worker → per giorno (usando timezone Europe/Rome)
  //    Map<workerId, { worker, days: Map<dateKey, log[]> }>
  //    dateKey = "YYYY-MM-DD" in ora italiana, NON UTC
  const byWorker = new Map();
  for (const log of (logs || [])) {
    if (!log.worker) continue;
    const wid     = log.worker_id;
    const dateKey = getDateKeyRome(log.timestamp_server);   // ← timezone Rome
    if (!byWorker.has(wid)) byWorker.set(wid, { worker: log.worker, days: new Map() });
    const wEntry = byWorker.get(wid);
    if (!wEntry.days.has(dateKey)) wEntry.days.set(dateKey, []);
    wEntry.days.get(dateKey).push(log);
  }

  const rows         = [];
  let   totalHours   = 0;
  const workerIds    = new Set();
  const totalPunches = (logs || []).length;

  for (const [, wData] of byWorker) {
    workerIds.add(wData.worker.id);

    for (const [dateKey, dayLogs] of wData.days) {
      // dayLogs già ordinati per timestamp_server asc (ORDER BY nella query)
      const result = pairDayIntervals(dayLogs, site.geofence_radius_m);

      totalHours += result.hoursTotal;

      rows.push({
        dateKey,
        date:            formatDateRome(dayLogs[0].timestamp_server),
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
        <td colspan="10" style="text-align:center;color:#888888;padding:16pt 0;font-size:9pt;">
          Nessuna presenza registrata nel periodo selezionato.
        </td>
      </tr>`;
  } else {
    for (const row of rows) {
      const isNewDate = row.dateKey !== prevDateKey;
      prevDateKey     = row.dateKey;

      const anomalyHtml = row.anomalies.length > 0
        ? row.anomalies.map(a => `<span class="badge-anom">${esc(a)}</span>`).join(' ')
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
      const methodsStr = row.methods && row.methods.length > 0 ? esc(row.methods.join(', ')) : '—';

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
<style>
/* ═══════════════════════════════════════════════════════════════════
   PALLADIA PDF — Registro Presenze Cantiere
   Architettura IDENTICA al POS (Puppeteer displayHeaderFooter:true):
     @page { margin: 26mm 0 24mm 0 } ↔ Puppeteer top:26mm / bottom:24mm
     .doc { padding: 0 16mm }        ↔ allineato ai template H/F
   ═══════════════════════════════════════════════════════════════════ */

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
  font-family: Arial, Helvetica, sans-serif;
  font-size: 10pt; color: #1E1E1E; line-height: 1.6; background: #FFFFFF;
}
.doc { width: 100%; max-width: 100%; box-sizing: border-box; padding: 0 16mm; }

/* ── COVER ──────────────────────────────────────────────────────────── */
/* height = 297mm - 26mm top - 24mm bottom = 247mm (identico al POS) */
.cover {
  break-after: page; page-break-after: always;
  display: flex; width: 100%; max-width: 100%;
}
.cover-sidebar {
  width: 62mm; max-width: 62mm; flex-shrink: 0;
  background: #1B3A5C; color: #FFFFFF;
  padding: 12mm 9mm 10mm 10mm;
  display: flex; flex-direction: column;
}
.cover-sidebar-brand {
  font-size: 10pt; font-weight: bold; letter-spacing: 3.5pt; text-transform: uppercase;
  color: #8DAFD4; margin-bottom: 10mm; padding-bottom: 6mm;
  border-bottom: 0.5pt solid #2E5A7A;
}
.cv-item  { margin-bottom: 7mm; }
.cv-label { font-size: 5.5pt; text-transform: uppercase; letter-spacing: 1.2pt; color: #8DAFD4; margin-bottom: 1.5mm; }
.cv-val   { font-size: 9pt; font-weight: bold; color: #FFFFFF; line-height: 1.4; }
.cv-val-lg { font-size: 16pt; font-weight: bold; color: #FFFFFF; line-height: 1; }
.cv-anom  { color: #F59E0B; }

.cover-main {
  flex: 1; padding: 14mm 12mm 10mm 14mm;
  display: flex; flex-direction: column;
}
.cover-badge {
  display: inline-block; font-size: 6pt; font-weight: bold; letter-spacing: 2pt;
  text-transform: uppercase; color: #1B3A5C; background: #E0ECF8;
  padding: 3pt 8pt; border-radius: 2pt; margin-bottom: 7mm; align-self: flex-start;
}
.cover-title {
  font-size: 21pt; font-weight: bold; color: #1B3A5C; line-height: 1.15;
  margin-bottom: 3mm;
}
.cover-subtitle {
  font-size: 8.5pt; color: #666666; line-height: 1.55; margin-bottom: 10mm; max-width: 88mm;
}
.cover-divider { border: none; border-top: 0.5pt solid #D0DBE8; margin-bottom: 8mm; }
.cover-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 5mm;
}
.cg-item   {}
.cg-label  { font-size: 6.5pt; text-transform: uppercase; letter-spacing: 0.9pt; color: #888888; margin-bottom: 1mm; }
.cg-value  { font-size: 9.5pt; font-weight: bold; color: #1E1E1E; line-height: 1.35; }
.cg-span2  { grid-column: 1 / -1; }
.cover-stamp {
  margin-top: auto; padding-top: 7mm; border-top: 0.5pt solid #D0DBE8;
  font-size: 6.5pt; color: #AAAAAA; line-height: 1.55; font-family: 'Courier New', monospace;
}

/* ── SECTION TITLE (identico al POS) ───────────────────────────────── */
.section-title {
  background: #1B3A5C; color: #FFFFFF;
  padding: 5pt 8pt; font-size: 9.5pt; font-weight: bold;
  letter-spacing: 0.8pt; text-transform: uppercase;
  margin-top: 14pt; margin-bottom: 8pt;
}
.section-title:first-of-type { margin-top: 8pt; }

/* ── CARDS RIEPILOGO ────────────────────────────────────────────────── */
.summary-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 5mm; margin-bottom: 10mm;
}
.summary-card {
  border: 0.5pt solid #C8D8E8; border-radius: 3pt;
  padding: 5mm 4mm; text-align: center;
}
.sc-num   { font-size: 20pt; font-weight: bold; color: #1B3A5C; line-height: 1; margin-bottom: 2mm; }
.sc-label { font-size: 6.5pt; color: #777777; text-transform: uppercase; letter-spacing: 0.7pt; }
.sc-warn  { border-color: #FFC107; background: #FFFDF0; }
.sc-warn .sc-num { color: #856404; }
.sc-ok   .sc-num { color: #166534; }

/* ── TABELLA PRESENZE ───────────────────────────────────────────────── */
/*
  Larghezza contenuto A4 = 210mm − 2×16mm = 178mm
  10 colonne — multi-intervallo:
    Data 9% · Lavoratore 18% · C.Fiscale 14% · P.Entrata 7% ·
    U.Uscita 7% · Ore 7% · N.Int 5% · Dist 6% · GPS 7% · Anomalie 20%
    = 100%
*/
.presence-table {
  width: 100%; table-layout: fixed; border-collapse: collapse;
  font-size: 8pt; margin-bottom: 12pt;
}
.presence-table thead th {
  background: #1B3A5C; color: #FFFFFF;
  padding: 4pt 3pt; font-size: 7.5pt; font-weight: bold;
  text-align: left; letter-spacing: 0.2pt;
  border: 0.5pt solid #1B3A5C;
}
.presence-table tbody td {
  padding: 4pt 3pt; vertical-align: top;
  border: 0.5pt solid #D8E4EE; line-height: 1.4;
}
.presence-table tbody tr:nth-child(even) td { background: #F4F7FB; }
.tr-newdate td { border-top: 1.5pt solid #7FA8CC !important; }
.tr-anom td    { background: #FFF8ED !important; }
.tr-anom:nth-child(even) td { background: #FFF3E0 !important; }

/* Larghezze colonne (table-layout:fixed) */
.col-date  { width:  9%; }
.col-name  { width: 18%; }
.col-cf    { width: 14%; }
.col-time  { width:  7%; }
.col-ore   { width:  7%; }
.col-nint  { width:  5%; }
.col-dist  { width:  6%; }
.col-gps   { width:  7%; }
.col-anom  { width: 20%; }  /* +2% extra → Anomalie testo più respiro */

.td-date  { font-weight: 600; color: #1B3A5C; white-space: nowrap; }
.td-name  { font-weight: 500; }
.td-cf    { font-family: 'Courier New', Courier, monospace; font-size: 7pt; letter-spacing: 0.1pt; }
.td-time  { text-align: center; white-space: nowrap; }
.td-num   { text-align: center; }
.td-anom-cell { }

.miss       { color: #C2410C; font-weight: bold; }
.td-ok      { color: #15803D; font-size: 9pt; }
.badge-anom {
  display: inline-block; font-size: 6pt; font-weight: bold;
  background: #FEF3C7; color: #92400E;
  border: 0.5pt solid #F59E0B; border-radius: 2pt;
  padding: 1pt 3pt; margin: 1pt 1pt 1pt 0; white-space: nowrap;
}

/* ── SEZIONE ANOMALIE ───────────────────────────────────────────────── */
.anom-box {
  background: #FFFBEB; border: 0.5pt solid #FCD34D; border-radius: 3pt;
  padding: 8pt 10pt; margin-bottom: 12pt;
}
.anom-list {
  font-size: 7.5pt; color: #333333; padding-left: 14pt; line-height: 1.65;
}
.anom-list li { margin-bottom: 2pt; }

/* ── DICHIARAZIONE FINALE ───────────────────────────────────────────── */
.declaration {
  margin-top: 14pt; border-top: 0.5pt solid #C8D8E8; padding-top: 10pt;
}
.declaration p { font-size: 7.5pt; color: #555555; line-height: 1.65; margin-bottom: 6pt; }
.declaration .doc-meta {
  font-size: 6.5pt; color: #AAAAAA; font-family: 'Courier New', monospace;
  line-height: 1.65; margin-top: 8pt;
}

/* ── ANTI-TAGLIO ────────────────────────────────────────────────────── */
h1, h2, h3 { break-after: avoid-page; page-break-after: avoid; }
tr    { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }

/* ══════════════════════════════════════════════════════════════════════
   BLOCCO FINALE v13 — identico al POS — vince su tutto (cascata CSS)
   @page margin DEVE coincidere con Puppeteer margin in makePdfOpts()
   ══════════════════════════════════════════════════════════════════════ */
@page { size: A4; margin: 26mm 0 24mm 0; }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0 !important; padding: 0 !important;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.doc  { width: 100% !important; max-width: 100% !important;
  padding: 0 16mm !important; box-sizing: border-box !important; }
.cover { height: 247mm !important; overflow: hidden !important; }
table { width: 100% !important; max-width: 100% !important;
  table-layout: fixed !important; border-collapse: collapse !important; }
th, td { max-width: 100% !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
thead { display: table-header-group; }
tr    { break-inside: avoid; page-break-inside: avoid; }
h1, h2, h3, .section-title { break-after: avoid-page !important; page-break-after: avoid !important; }
.summary-card, .anom-box, .declaration { break-inside: avoid !important; page-break-inside: avoid !important; }
</style>
</head>
<body>
<div class="doc">

  <!-- ══ COVER ══════════════════════════════════════════════════════════ -->
  <div class="cover">
    <div class="cover-sidebar">
      <div class="cover-sidebar-brand">Palladia</div>

      <div class="cv-item">
        <div class="cv-label">Lavoratori</div>
        <div class="cv-val-lg">${total_workers}</div>
      </div>
      <div class="cv-item">
        <div class="cv-label">Timbrature totali</div>
        <div class="cv-val">${total_punches}</div>
      </div>
      <div class="cv-item">
        <div class="cv-label">Ore lavorate</div>
        <div class="cv-val">${esc(totalHoursStr)}</div>
      </div>
      ${anomalies_count > 0 ? `
      <div class="cv-item" style="margin-top:auto;">
        <div class="cv-label">Anomalie</div>
        <div class="cv-val cv-anom">${anomalies_count} sessioni</div>
      </div>` : `
      <div class="cv-item" style="margin-top:auto;">
        <div class="cv-label">Anomalie</div>
        <div class="cv-val" style="color:#4ADE80;">Nessuna</div>
      </div>`}
    </div>

    <div class="cover-main">
      <div class="cover-badge">Registro Ufficiale Presenze</div>
      <div class="cover-title">Registro Presenze<br>Cantiere</div>
      <div class="cover-subtitle">
        Generato automaticamente tramite sistema digitale geolocalizzato PalladIA.
        Ogni timbratura è verificata server-side con geofence GPS e registrata
        in database append-only (immutabile).
      </div>

      <hr class="cover-divider">

      <div class="cover-grid">
        <div class="cg-item">
          <div class="cg-label">Impresa</div>
          <div class="cg-value">${esc(company.name || '—')}</div>
        </div>
        <div class="cg-item">
          <div class="cg-label">Cantiere</div>
          <div class="cg-value">${esc(site.name)}</div>
        </div>
        <div class="cg-item">
          <div class="cg-label">Periodo</div>
          <div class="cg-value">${esc(periodStr)}</div>
        </div>
        <div class="cg-item">
          <div class="cg-label">Generato il</div>
          <div class="cg-value">${esc(genDateStr)}</div>
        </div>
        ${site.address ? `
        <div class="cg-item cg-span2">
          <div class="cg-label">Indirizzo cantiere</div>
          <div class="cg-value">${esc(site.address)}</div>
        </div>` : ''}
      </div>

      <div class="cover-stamp">
        ID documento: ${doc_id}<br>
        Timestamp generazione: ${generated_at}<br>
        Cantiere ID: ${site.id}
      </div>
    </div>
  </div>

  <!-- ══ RIEPILOGO ══════════════════════════════════════════════════════ -->
  <div class="section-title">Riepilogo del periodo — ${esc(periodStr)}</div>
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
      <col style="width:9mm;"> <col class="col-anom">
    </colgroup>
    <thead>
      <tr>
        <th>Data</th>
        <th>Lavoratore</th>
        <th>C. Fiscale</th>
        <th style="text-align:center;">P. Entrata</th>
        <th style="text-align:center;">U. Uscita</th>
        <th style="text-align:center;">Ore tot.</th>
        <th style="text-align:center;">Int.</th>
        <th style="text-align:center;">Dist.</th>
        <th style="text-align:center;">GPS ±m</th>
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
      Il presente registro è stato generato automaticamente dal sistema PalladIA con
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
      Sistema      : PalladIA — Registro Digitale Presenze v1.0
    </div>
  </div>

</div><!-- /doc -->
</body>
</html>`;
}

module.exports = { buildDailyPresenceSummary, generatePresenceReportHtml };
