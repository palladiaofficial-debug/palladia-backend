'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt }              = require('../../middleware/verifyJwt');
const { getActualWeather, evalThresholds, WMO } = require('../../services/weatherService');
const { calcEndDate }                    = require('../../lib/calcEndDate');
const ExcelJS                            = require('exceljs');

// ── Utility ────────────────────────────────────────────────────────────────────

function toItDate(iso) {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00').toLocaleDateString('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

function toItShort(iso) {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00').toLocaleDateString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

async function getSiteOrFail(siteId, companyId, res) {
  const { data } = await supabase
    .from('sites')
    .select('id, name, address, client, start_date, end_date, contract_days, days_type, latitude, longitude')
    .eq('id', siteId)
    .eq('company_id', companyId)
    .neq('status', 'eliminato')
    .maybeSingle();
  if (!data) { res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' }); return null; }
  return data;
}

// ── GET /api/v1/sites/:siteId/weather-log ─────────────────────────────────────
// Storico dati meteo salvati. Opzionale ?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/sites/:siteId/weather-log', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { from, to } = req.query;

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  let q = supabase
    .from('site_weather_logs')
    .select('id, log_date, precipitation_mm, wind_max_kmh, temp_min_c, temp_max_c, weather_code, weather_desc, threshold_exceeded, threshold_reason, suspension_confirmed, suspension_dismissed, suspension_id, fetched_at')
    .eq('site_id', siteId)
    .order('log_date', { ascending: false })
    .limit(365);

  if (from) q = q.gte('log_date', from);
  if (to)   q = q.lte('log_date', to);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── POST /api/v1/sites/:siteId/weather-log/fetch ──────────────────────────────
// Fetch manuale dei dati meteo per una o più date (backfill o aggiornamento).
// Body: { dates: ['YYYY-MM-DD', ...] }
router.post('/sites/:siteId/weather-log/fetch', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { dates }  = req.body || {};

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  if (!site.latitude || !site.longitude) {
    return res.status(400).json({ error: 'NO_COORDS', message: 'Imposta le coordinate GPS del cantiere prima.' });
  }

  const targetDates = Array.isArray(dates) && dates.length
    ? dates.slice(0, 30) // max 30 date per chiamata
    : [new Date(Date.now() - 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })]; // ieri

  const results = [];
  for (const d of targetDates) {
    try {
      const weather  = await getActualWeather(site.latitude, site.longitude, d);
      const { exceeded, reason } = evalThresholds(weather);

      const { data: row } = await supabase
        .from('site_weather_logs')
        .upsert({
          company_id:         req.companyId,
          site_id:            siteId,
          log_date:           d,
          precipitation_mm:   weather.precipitation_mm,
          wind_max_kmh:       weather.wind_max_kmh,
          temp_min_c:         weather.temp_min,
          temp_max_c:         weather.temp_max,
          weather_code:       weather.weather_code,
          weather_desc:       weather.weather_desc,
          threshold_exceeded: exceeded,
          threshold_reason:   reason ?? null,
          fetched_at:         new Date().toISOString(),
        }, { onConflict: 'site_id,log_date' })
        .select()
        .single();

      results.push({ date: d, ok: true, data: row });
    } catch (err) {
      results.push({ date: d, ok: false, error: err.message });
    }
  }

  res.json({ results });
});

// ── POST /api/v1/sites/:siteId/weather-log/:date/confirm ─────────────────────
// Conferma sospensione: crea il giorno in site_suspension_days + aggiorna log.
router.post('/sites/:siteId/weather-log/:date/confirm', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const { notes }        = req.body || {};

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  // Recupera il log meteo
  const { data: log } = await supabase
    .from('site_weather_logs')
    .select('id, threshold_reason, precipitation_mm, wind_max_kmh, weather_desc')
    .eq('site_id', siteId)
    .eq('log_date', date)
    .maybeSingle();

  if (!log) return res.status(404).json({ error: 'LOG_NOT_FOUND' });

  // Costruisce note automatiche con i dati meteo
  const autoNotes = [
    log.weather_desc,
    log.precipitation_mm > 0 ? `${log.precipitation_mm}mm pioggia` : null,
    log.wind_max_kmh > 0    ? `vento ${log.wind_max_kmh}km/h max` : null,
    notes ? `— ${notes}` : null,
    '| Fonte: Open-Meteo / ERA5',
  ].filter(Boolean).join(' · ');

  // Crea il giorno di sospensione
  const { data: suspension, error: suspErr } = await supabase
    .from('site_suspension_days')
    .upsert({
      company_id: req.companyId,
      site_id:    siteId,
      day:        date,
      reason:     log.threshold_reason || 'pioggia',
      notes:      autoNotes,
      created_by: req.user?.id ?? null,
    }, { onConflict: 'site_id,day' })
    .select('id')
    .single();

  if (suspErr) return res.status(500).json({ error: 'DB_ERROR', message: suspErr.message });

  // Aggiorna il log con il link alla sospensione
  await supabase
    .from('site_weather_logs')
    .update({ suspension_confirmed: true, suspension_id: suspension.id })
    .eq('id', log.id);

  // Ricalcola end_date del cantiere
  const { data: suspRows } = await supabase
    .from('site_suspension_days').select('day').eq('site_id', siteId);
  const newEnd = calcEndDate(site.start_date, site.contract_days, site.days_type, (suspRows||[]).map(r=>r.day));
  if (newEnd) await supabase.from('sites').update({ end_date: newEnd }).eq('id', siteId).eq('company_id', req.companyId);

  // Aggiorna notifica (rimuovi questo giorno dal conteggio pendenti)
  const { data: pending } = await supabase
    .from('site_weather_logs').select('log_date')
    .eq('site_id', siteId).eq('threshold_exceeded', true)
    .eq('suspension_confirmed', false).eq('suspension_dismissed', false);

  const pendingDays = (pending || []).map(r => r.log_date);
  if (pendingDays.length === 0) {
    await supabase.from('notifications').delete()
      .eq('company_id', req.companyId).eq('entity_type', 'site')
      .eq('entity_id', siteId).eq('type', 'weather_suspension');
  } else {
    const listIt = pendingDays.sort().map(d => new Date(d+'T00:00:00').toLocaleDateString('it-IT',{day:'numeric',month:'long'}));
    await supabase.from('notifications').upsert({
      company_id: req.companyId, type: 'weather_suspension', severity: 'warning',
      title: `Meteo — ${pendingDays.length} ${pendingDays.length===1?'giornata':'giornate'} da confermare`,
      body: `${site.name}\n${listIt.join(' · ')}`,
      entity_type: 'site', entity_id: siteId, updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,entity_type,entity_id,type' });
  }

  res.json({ ok: true, suspension, newEndDate: newEnd ?? null });
});

// ── POST /api/v1/sites/:siteId/weather-log/:date/dismiss ─────────────────────
router.post('/sites/:siteId/weather-log/:date/dismiss', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  await supabase
    .from('site_weather_logs')
    .update({ suspension_dismissed: true })
    .eq('site_id', siteId).eq('log_date', date);

  const { data: pending } = await supabase
    .from('site_weather_logs').select('log_date')
    .eq('site_id', siteId).eq('threshold_exceeded', true)
    .eq('suspension_confirmed', false).eq('suspension_dismissed', false);

  if (!pending?.length) {
    await supabase.from('notifications').delete()
      .eq('company_id', req.companyId).eq('entity_type', 'site')
      .eq('entity_id', siteId).eq('type', 'weather_suspension');
  }

  res.json({ ok: true });
});

// ── GET /api/v1/sites/:siteId/weather-report.xlsx ────────────────────────────
router.get('/sites/:siteId/weather-report.xlsx', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { from, to } = req.query;

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  let q = supabase
    .from('site_weather_logs')
    .select('log_date, precipitation_mm, wind_max_kmh, temp_min_c, temp_max_c, weather_desc, threshold_exceeded, threshold_reason, suspension_confirmed, suspension_dismissed')
    .eq('site_id', siteId)
    .order('log_date', { ascending: true });

  if (from) q = q.gte('log_date', from);
  if (to)   q = q.lte('log_date', to);

  const { data: logs } = await q;
  const rows = logs || [];

  // Calcola statistiche
  const totalDays        = rows.length;
  const rainDays         = rows.filter(r => r.threshold_exceeded).length;
  const confirmedDays    = rows.filter(r => r.suspension_confirmed).length;
  const totalMm          = rows.reduce((s, r) => s + Number(r.precipitation_mm || 0), 0);
  const maxWind          = rows.reduce((m, r) => Math.max(m, Number(r.wind_max_kmh || 0)), 0);

  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Palladia';
  wb.created  = new Date();

  // ── Foglio 1: Dati giornalieri ──
  const ws = wb.addWorksheet('Registro Meteo', {
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  // Header azienda / cantiere
  ws.mergeCells('A1:J1');
  ws.getCell('A1').value = `REGISTRO METEO CANTIERE — ${(site.name||'').toUpperCase()}`;
  ws.getCell('A1').font = { size: 14, bold: true, color: { argb: 'FF1A1A2E' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
  ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  ws.mergeCells('A2:J2');
  const period = (from || site.start_date || '—') + ' → ' + (to || site.end_date || 'oggi');
  ws.getCell('A2').value = `Indirizzo: ${site.address || '—'}  |  Committente: ${site.client || '—'}  |  Periodo: ${period}`;
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF555555' } };
  ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.getRow(2).height = 18;

  ws.addRow([]); // riga vuota

  // Intestazione colonne
  const HEADER = [
    'Data', 'Giorno', 'Condizioni', 'Precipitazioni (mm)',
    'Vento max (km/h)', 'T° min', 'T° max',
    'Soglia superata', 'Sospensione confermata', 'Motivo'
  ];
  const hRow = ws.addRow(HEADER);
  hRow.height = 20;
  hRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A2E' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF4A90D9' } } };
  });

  const DAYS_IT = ['Domenica','Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'];

  rows.forEach((r, i) => {
    const dt      = new Date(r.log_date + 'T00:00:00');
    const dow     = DAYS_IT[dt.getDay()];
    const isWarn  = r.threshold_exceeded && !r.suspension_confirmed && !r.suspension_dismissed;
    const isConf  = r.suspension_confirmed;

    const row = ws.addRow([
      r.log_date,
      dow,
      r.weather_desc || '—',
      Number(r.precipitation_mm) || 0,
      Number(r.wind_max_kmh) || 0,
      r.temp_min_c != null ? `${r.temp_min_c}°C` : '—',
      r.temp_max_c != null ? `${r.temp_max_c}°C` : '—',
      r.threshold_exceeded ? 'Sì' : 'No',
      isConf ? 'CONFERMATA' : (r.suspension_dismissed ? 'Ignorata' : (r.threshold_exceeded ? 'In attesa' : '—')),
      r.threshold_reason || '—',
    ]);

    row.height = 16;
    const bg = isConf  ? 'FFFFD6D6' :
               isWarn  ? 'FFFFF3CD' :
               (i % 2 === 0) ? 'FFFFFFFF' : 'FFF9F9F9';

    row.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.font = { size: 9 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE0E0E0' } } };
    });

    if (isConf) {
      ['I','J'].forEach(col => {
        ws.getCell(`${col}${row.number}`).font = { size: 9, bold: true, color: { argb: 'FF990000' } };
      });
    }
  });

  // Colonne larghezze
  ws.columns = [
    { width: 14 }, { width: 12 }, { width: 22 }, { width: 20 },
    { width: 20 }, { width: 10 }, { width: 10 },
    { width: 16 }, { width: 22 }, { width: 14 },
  ];

  // ── Foglio 2: Sommario ──
  const ws2 = wb.addWorksheet('Sommario');

  const addStat = (label, value, bold = false) => {
    const r = ws2.addRow([label, value]);
    if (bold) r.getCell(1).font = { bold: true };
    r.getCell(2).alignment = { horizontal: 'right' };
  };

  ws2.getColumn(1).width = 40;
  ws2.getColumn(2).width = 20;

  ws2.addRow(['SOMMARIO METEO CANTIERE']).getCell(1).font = { size: 13, bold: true };
  ws2.addRow([site.name || '—']).getCell(1).font = { italic: true };
  ws2.addRow([]);
  addStat('Giorni monitorati',                     totalDays);
  addStat('Giorni con condizioni avverse',         rainDays,       true);
  addStat('Giorni sospensione confermati',         confirmedDays,  true);
  addStat('Precipitazioni totali periodo (mm)',    totalMm.toFixed(1));
  addStat('Vento massimo registrato (km/h)',        maxWind.toFixed(1));
  ws2.addRow([]);
  if (site.contract_days) {
    addStat('Giorni contratto',     site.contract_days + ' (' + (site.days_type || 'solari') + ')');
    addStat('Data inizio lavori',   toItShort(site.start_date));
    addStat('Data fine contratto originale', toItShort(site.end_date));
    addStat('Giorni sospensione applicati', confirmedDays);
  }
  ws2.addRow([]);
  ws2.addRow(['Fonte dati']).getCell(1).font = { bold: true };
  ws2.addRow(['Open-Meteo.com — ERA5 Climate Reanalysis (ECMWF)']);
  ws2.addRow([`Generato da Palladia il ${new Date().toLocaleDateString('it-IT')} alle ${new Date().toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'})}`]);
  ws2.addRow(['Documento valido come prova documentale per contratti di appalto (D.Lgs. 50/2016)']);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="meteo_${siteId}_${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ── GET /api/v1/sites/:siteId/weather-report.pdf ─────────────────────────────
router.get('/sites/:siteId/weather-report.pdf', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { from, to } = req.query;

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  let q = supabase
    .from('site_weather_logs')
    .select('log_date, precipitation_mm, wind_max_kmh, temp_min_c, temp_max_c, weather_desc, weather_code, threshold_exceeded, threshold_reason, suspension_confirmed, suspension_dismissed')
    .eq('site_id', siteId)
    .order('log_date', { ascending: true });

  if (from) q = q.gte('log_date', from);
  if (to)   q = q.lte('log_date', to);

  const { data: logs } = await q;
  const rows = logs || [];

  const confirmedDays = rows.filter(r => r.suspension_confirmed).length;
  const totalMm       = rows.reduce((s, r) => s + Number(r.precipitation_mm || 0), 0);

  const DAYS_IT = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];

  const tableRows = rows.map(r => {
    const dt    = new Date(r.log_date + 'T00:00:00');
    const isConf = r.suspension_confirmed;
    const isWarn = r.threshold_exceeded && !r.suspension_confirmed && !r.suspension_dismissed;
    const bg    = isConf ? '#ffd6d6' : isWarn ? '#fff3cd' : 'transparent';
    const icon  = r.threshold_exceeded
      ? (r.threshold_reason === 'neve' ? '❄️' : r.threshold_reason === 'vento' ? '💨' : r.threshold_reason === 'temporale' ? '⛈️' : '🌧️')
      : (r.weather_code <= 3 ? '☀️' : '⛅');

    return `<tr style="background:${bg}">
      <td>${r.log_date}</td>
      <td>${DAYS_IT[dt.getDay()]}</td>
      <td>${icon} ${r.weather_desc || '—'}</td>
      <td class="num">${r.precipitation_mm > 0 ? r.precipitation_mm + ' mm' : '—'}</td>
      <td class="num">${r.wind_max_kmh > 0 ? r.wind_max_kmh + ' km/h' : '—'}</td>
      <td class="num">${r.temp_min_c != null ? r.temp_min_c + '°' : '—'} / ${r.temp_max_c != null ? r.temp_max_c + '°' : '—'}</td>
      <td class="center ${isConf ? 'susp-yes' : ''}">${isConf ? 'SOSPESO' : (r.suspension_dismissed ? 'ignorato' : (r.threshold_exceeded ? '⚠️ da confermare' : '—'))}</td>
    </tr>`;
  }).join('');

  const period = (from || site.start_date || '—') + ' → ' + (to || site.end_date || 'oggi');
  const nowStr = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

  const html = `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 9pt; color: #111; }
  .page { padding: 18mm 14mm; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8mm; border-bottom: 2px solid #1a1a2e; padding-bottom: 4mm; }
  .header-left h1 { font-size: 13pt; font-weight: 800; color: #1a1a2e; }
  .header-left p { font-size: 8pt; color: #555; margin-top: 2px; }
  .header-right { text-align: right; font-size: 8pt; color: #555; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 7pt; font-weight: 700; }
  .badge-palladia { background: #1a1a2e; color: #fff; margin-bottom: 4px; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4mm; margin-bottom: 6mm; }
  .meta-box { background: #f5f5f5; border-radius: 4px; padding: 3mm 4mm; }
  .meta-box .label { font-size: 7pt; color: #777; text-transform: uppercase; letter-spacing: .5px; }
  .meta-box .val { font-size: 10pt; font-weight: 700; color: #1a1a2e; margin-top: 1px; }
  .meta-box.red .val { color: #cc0000; }
  table { width: 100%; border-collapse: collapse; font-size: 8pt; }
  thead th { background: #1a1a2e; color: #fff; padding: 4px 5px; text-align: left; font-weight: 700; font-size: 7.5pt; }
  thead th.num, thead th.center { text-align: center; }
  tbody td { padding: 3.5px 5px; border-bottom: 1px solid #e8e8e8; vertical-align: middle; }
  tbody td.num { text-align: center; }
  tbody td.center { text-align: center; }
  tbody td.susp-yes { font-weight: 700; color: #cc0000; }
  tbody tr:hover { background: #fafafa; }
  .footer { margin-top: 8mm; border-top: 1px solid #ddd; padding-top: 3mm; display: flex; justify-content: space-between; font-size: 7pt; color: #777; }
</style>
</head><body><div class="page">
  <div class="header">
    <div class="header-left">
      <div class="badge badge-palladia">PALLADIA</div>
      <h1>Registro Meteo Cantiere</h1>
      <p>${site.name || ''} · ${site.address || ''}</p>
      <p>Committente: <strong>${site.client || '—'}</strong> · Periodo: <strong>${period}</strong></p>
    </div>
    <div class="header-right">
      <p>Generato il</p>
      <p><strong>${nowStr}</strong></p>
    </div>
  </div>

  <div class="meta-grid">
    <div class="meta-box">
      <div class="label">Giorni monitorati</div>
      <div class="val">${rows.length}</div>
    </div>
    <div class="meta-box red">
      <div class="label">Giorni sospensione confermati</div>
      <div class="val">${confirmedDays}</div>
    </div>
    <div class="meta-box">
      <div class="label">Precipitazioni totali</div>
      <div class="val">${totalMm.toFixed(1)} mm</div>
    </div>
    ${site.contract_days ? `
    <div class="meta-box">
      <div class="label">Giorni contratto</div>
      <div class="val">${site.contract_days} (${site.days_type || 'solari'})</div>
    </div>
    <div class="meta-box">
      <div class="label">Inizio lavori</div>
      <div class="val">${toItShort(site.start_date)}</div>
    </div>
    <div class="meta-box">
      <div class="label">Fine lavori (aggiornata)</div>
      <div class="val">${toItShort(site.end_date)}</div>
    </div>` : ''}
  </div>

  <table>
    <thead><tr>
      <th>Data</th><th>G.</th><th>Condizioni</th>
      <th class="num">Pioggia</th><th class="num">Vento max</th><th class="num">T° min/max</th>
      <th class="center">Sospensione</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>

  <div class="footer">
    <span>Fonte dati: <strong>Open-Meteo.com · ERA5 Climate Reanalysis (ECMWF)</strong> — dati verificabili pubblicamente</span>
    <span>Palladia · Documento valido come prova documentale (D.Lgs. 50/2016)</span>
  </div>
</div></body></html>`;

  try {
    const { renderHtmlToPdf } = require('../../pdf-renderer');
    const pdfBuf = await renderHtmlToPdf(html, {
      format: 'A4', landscape: true,
      margin: { top: '12mm', bottom: '12mm', left: '0', right: '0' },
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="meteo_${siteId}_${Date.now()}.pdf"`);
    res.send(pdfBuf);
  } catch (err) {
    console.error('[weather-report.pdf]', err.message);
    res.status(500).json({ error: 'PDF_ERROR', message: err.message });
  }
});

module.exports = router;
