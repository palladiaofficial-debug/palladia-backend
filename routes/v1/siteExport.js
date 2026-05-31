'use strict';
/**
 * routes/v1/siteExport.js
 * GET /api/v1/sites/:siteId/export?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Genera un archivio XLSX multi-foglio del cantiere:
 *   Foglio 1 — Info cantiere
 *   Foglio 2 — Lavoratori assegnati
 *   Foglio 3 — Registro presenze (riepilogo giornaliero)
 *   Foglio 4 — Subappaltatori assegnati
 *
 * from/to opzionali: default = tutta la durata del cantiere (o ultimi 365gg).
 */

const router   = require('express').Router();
const ExcelJS  = require('exceljs');
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };

function styleHeader(sheet) {
  const row = sheet.getRow(1);
  row.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  row.height = 22;
}

function fmtDate(d) {
  if (!d) return '';
  return String(d).slice(0, 10);
}

function fmtBool(v) {
  return v ? 'Sì' : 'No';
}

router.get('/sites/:siteId/export', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  let { from, to } = req.query;

  // Validazione date opzionali
  if (from && !DATE_RE.test(from)) return res.status(400).json({ error: 'INVALID_FROM' });
  if (to   && !DATE_RE.test(to))   return res.status(400).json({ error: 'INVALID_TO' });
  if (from && to && from > to)     return res.status(400).json({ error: 'FROM_AFTER_TO' });

  // ── Fetch dati in parallelo ───────────────────────────────────────────────
  const [siteRes, workersRes, subsRes] = await Promise.all([
    supabase
      .from('sites')
      .select('id, name, address, client, status, start_date, end_date, contract_days, days_type, referente_tecnico_id, referente_tecnico_name, suolo_occupazione, suolo_occupazione_start, suolo_occupazione_end, suolo_occupazione_notes, latitude, longitude, geofence_radius_m')
      .eq('id', siteId)
      .eq('company_id', req.companyId)
      .neq('status', 'eliminato')
      .maybeSingle(),

    supabase
      .from('worksite_workers')
      .select('worker_id, status, workers!inner(id, full_name, fiscal_code, qualification, hire_date, is_active)')
      .eq('site_id', siteId)
      .eq('company_id', req.companyId),

    supabase
      .from('site_subcontractors')
      .select('id, role, assigned_at, subcontractor:subcontractor_id(company_name, piva, contact_person, phone, email, durc_expiry, insurance_expiry, soa_expiry)')
      .eq('site_id', siteId)
      .eq('company_id', req.companyId),
  ]);

  if (!siteRes.data) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
  const site = siteRes.data;

  // Range presenze: se non specificato, usa start_date–oggi (max 365gg)
  const today = new Date().toISOString().slice(0, 10);
  const rangeFrom = from || (site.start_date ? fmtDate(site.start_date) : new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10));
  const rangeTo   = to   || today;
  const daysDiff  = (new Date(rangeTo) - new Date(rangeFrom)) / 86400000;
  if (daysDiff > 366) return res.status(400).json({ error: 'RANGE_TOO_LARGE', message: 'Intervallo massimo 366 giorni' });

  // Fetch presenze
  const { data: logs } = await supabase
    .from('presence_logs')
    .select('worker_id, event_type, timestamp_server, worker:workers(full_name, fiscal_code)')
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .gte('timestamp_server', `${rangeFrom}T00:00:00.000Z`)
    .lte('timestamp_server', `${rangeTo}T23:59:59.999Z`)
    .order('worker_id',        { ascending: true })
    .order('timestamp_server', { ascending: true })
    .limit(50001);

  if ((logs || []).length > 50000)
    return res.status(400).json({ error: 'TOO_MANY_ROWS', message: 'Export limitato a 50.000 timbrature. Riduci l\'intervallo di date.' });

  // ── Costruzione workbook ──────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Palladia';
  wb.created  = new Date();

  // ── Foglio 1: Info cantiere ───────────────────────────────────────────────
  const sh1 = wb.addWorksheet('Cantiere');
  sh1.columns = [
    { header: 'Campo', width: 28 },
    { header: 'Valore', width: 42 },
  ];
  styleHeader(sh1);

  const siteRows = [
    ['Nome cantiere',          site.name],
    ['Indirizzo',              site.address    || ''],
    ['Cliente',                site.client     || ''],
    ['Stato',                  site.status],
    ['Data inizio',            fmtDate(site.start_date)],
    ['Data fine',              fmtDate(site.end_date)],
    ['Giorni contratto',       site.contract_days   || ''],
    ['Tipo giorni',            site.days_type || 'solari'],
    ['Referente tecnico',      site.referente_tecnico_name || ''],
    ['Lat/Lon',                site.latitude ? `${site.latitude}, ${site.longitude}` : ''],
    ['Geofence (m)',           site.geofence_radius_m || ''],
    ['Occupazione suolo',      fmtBool(site.suolo_occupazione)],
    ['Suolo inizio',           fmtDate(site.suolo_occupazione_start)],
    ['Suolo fine',             fmtDate(site.suolo_occupazione_end)],
    ['Note suolo',             site.suolo_occupazione_notes || ''],
    ['Range presenze export',  `${rangeFrom} → ${rangeTo}`],
  ];
  for (const [campo, valore] of siteRows) {
    const row = sh1.addRow([campo, valore]);
    row.getCell(1).font = { bold: true };
  }

  // ── Foglio 2: Lavoratori ─────────────────────────────────────────────────
  const sh2 = wb.addWorksheet('Lavoratori');
  sh2.columns = [
    { header: 'Nome',            width: 30 },
    { header: 'Codice fiscale',  width: 18 },
    { header: 'Qualifica',       width: 22 },
    { header: 'Data assunzione', width: 16 },
    { header: 'Attivo',          width: 10 },
    { header: 'Stato cantiere',  width: 16 },
  ];
  styleHeader(sh2);

  for (const r of (workersRes.data || [])) {
    const w = r.workers;
    sh2.addRow([
      w.full_name,
      w.fiscal_code,
      w.qualification || '',
      fmtDate(w.hire_date),
      fmtBool(w.is_active),
      r.status,
    ]);
  }

  // ── Foglio 3: Presenze ───────────────────────────────────────────────────
  const sh3 = wb.addWorksheet('Presenze');
  sh3.columns = [
    { header: 'Data',              width: 12 },
    { header: 'Lavoratore',        width: 28 },
    { header: 'Codice fiscale',    width: 18 },
    { header: 'Prima entrata',     width: 14 },
    { header: 'Ultima uscita',     width: 14 },
    { header: 'Ore totali',        width: 12 },
    { header: 'N. ingressi',       width: 12 },
    { header: 'Anomalie',          width: 30 },
  ];
  styleHeader(sh3);

  const fmtTime = ts => new Date(ts).toLocaleTimeString('it-IT', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome',
  });

  const byWorkerDay = new Map();
  for (const log of (logs || [])) {
    if (!log.worker) continue;
    const dateKey = new Date(log.timestamp_server).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
    const key = `${log.worker_id}::${dateKey}`;
    if (!byWorkerDay.has(key)) byWorkerDay.set(key, { worker: log.worker, dateKey, logs: [] });
    byWorkerDay.get(key).logs.push(log);
  }

  const sortedKeys = Array.from(byWorkerDay.keys()).sort((a, b) => {
    const [, dA] = a.split('::'); const [, dB] = b.split('::');
    if (dA !== dB) return dA.localeCompare(dB);
    return byWorkerDay.get(a).worker.full_name.localeCompare(byWorkerDay.get(b).worker.full_name);
  });

  for (const key of sortedKeys) {
    const { worker, dateKey, logs: dayLogs } = byWorkerDay.get(key);
    const anomalies = [];
    let hoursTotal = 0;
    let intervals  = 0;
    let i = 0;
    while (i < dayLogs.length) {
      const l = dayLogs[i];
      if (l.event_type === 'ENTRY') {
        const next = i + 1 < dayLogs.length ? dayLogs[i + 1] : null;
        if (next && next.event_type === 'EXIT') {
          hoursTotal += Math.max(0, (new Date(next.timestamp_server) - new Date(l.timestamp_server)) / 3600000);
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
    const entries = dayLogs.filter(l => l.event_type === 'ENTRY');
    const exits   = dayLogs.filter(l => l.event_type === 'EXIT');
    sh3.addRow([
      dateKey,
      worker.full_name,
      worker.fiscal_code,
      entries.length > 0 ? fmtTime(entries[0].timestamp_server) : '',
      exits.length   > 0 ? fmtTime(exits[exits.length - 1].timestamp_server) : '',
      hoursTotal > 0 ? parseFloat(hoursTotal.toFixed(2)) : '',
      intervals,
      anomalies.join('; '),
    ]);
  }

  // ── Foglio 4: Subappaltatori ─────────────────────────────────────────────
  const sh4 = wb.addWorksheet('Subappaltatori');
  sh4.columns = [
    { header: 'Ragione sociale',    width: 30 },
    { header: 'P. IVA',             width: 14 },
    { header: 'Referente',          width: 22 },
    { header: 'Telefono',           width: 16 },
    { header: 'Email',              width: 28 },
    { header: 'Ruolo in cantiere',  width: 22 },
    { header: 'DURC scadenza',      width: 14 },
    { header: 'Assicurazione sc.',  width: 14 },
    { header: 'SOA scadenza',       width: 14 },
    { header: 'Assegnato il',       width: 14 },
  ];
  styleHeader(sh4);

  for (const r of (subsRes.data || [])) {
    const s = r.subcontractor;
    sh4.addRow([
      s?.company_name   || '',
      s?.piva           || '',
      s?.contact_person || '',
      s?.phone          || '',
      s?.email          || '',
      r.role            || '',
      fmtDate(s?.durc_expiry),
      fmtDate(s?.insurance_expiry),
      fmtDate(s?.soa_expiry),
      fmtDate(r.assigned_at),
    ]);
  }

  // ── Risposta ─────────────────────────────────────────────────────────────
  const safeName = (site.name || 'cantiere').replace(/[^a-z0-9_\-]/gi, '_').slice(0, 40);
  const filename = `archivio-${safeName}-${rangeFrom}-${rangeTo}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await wb.xlsx.write(res);
  res.end();
});

module.exports = router;
