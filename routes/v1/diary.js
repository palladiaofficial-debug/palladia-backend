'use strict';
// ── Diario di Cantiere ────────────────────────────────────────────────────────
// GET  /api/v1/sites/:siteId/diary                — lista voci del mese
// GET  /api/v1/sites/:siteId/diary/prefill/:date  — dati pre-compilati (no save)
// GET  /api/v1/sites/:siteId/diary/:date          — voce singola
// POST /api/v1/sites/:siteId/diary                — crea/aggiorna (upsert)
// POST /api/v1/sites/:siteId/diary/photos         — upload foto (multipart)
// DELETE /api/v1/sites/:siteId/diary/photos       — elimina foto da storage
// DELETE /api/v1/sites/:siteId/diary/:date        — elimina
// GET  /api/v1/sites/:siteId/diary/:date/pdf      — export PDF
// ─────────────────────────────────────────────────────────────────────────────
const crypto   = require('crypto');
const path     = require('path');
const multer   = require('multer');
const router   = require('express').Router();
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { getActualWeather }   = require('../../services/weatherService');

const BUCKET = 'site-documents';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo immagini consentite (JPG, PNG, WebP).'));
  },
});

// ── GET /api/v1/sites/:siteId/diary ──────────────────────────────────────────
router.get('/sites/:siteId/diary', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const m    = (req.query.month || new Date().toISOString().slice(0, 7));
  const from = `${m}-01`;
  const to   = new Date(new Date(from + 'T00:00:00').setMonth(
    new Date(from + 'T00:00:00').getMonth() + 1
  ) - 86400000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('site_diary_entries')
    .select('id, entry_date, weather_code, weather_desc, temp_min, temp_max, precipitation_mm, activities, issues, work_hours_total, workers_snapshot, photos')
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .gte('entry_date', from)
    .lte('entry_date', to)
    .order('entry_date', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// ── GET /api/v1/sites/:siteId/diary/prefill/:date ─────────────────────────────
router.get('/sites/:siteId/diary/prefill/:date', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const [presenceRes, equipRes, subsRes, weatherLogRes] = await Promise.all([
    supabase
      .from('presence_logs')
      .select('worker_id, event_type, timestamp_server, workers(full_name)')
      .eq('site_id', siteId)
      .eq('company_id', req.companyId)
      .gte('timestamp_server', `${date}T00:00:00`)
      .lte('timestamp_server', `${date}T23:59:59`)
      .order('timestamp_server', { ascending: true }),

    supabase
      .from('site_equipment')
      .select('equipment_id, equipment:equipment_id(type, model, plate_or_serial)')
      .eq('site_id', siteId)
      .eq('company_id', req.companyId),

    supabase
      .from('site_subcontractors')
      .select('subcontractor_id, subcontractors(company_name)')
      .eq('site_id', siteId)
      .eq('company_id', req.companyId),

    supabase
      .from('site_weather_logs')
      .select('weather_code, weather_desc, temp_min_c, temp_max_c, precipitation_mm, wind_max_kmh')
      .eq('site_id', siteId)
      .eq('log_date', date)
      .maybeSingle(),
  ]);

  // Calcola ore per lavoratore dai punch ENTRY/EXIT
  const workerMap = {};
  for (const log of (presenceRes.data || [])) {
    const wid = log.worker_id;
    if (!workerMap[wid]) {
      workerMap[wid] = { id: wid, name: log.workers?.full_name || 'Lavoratore', entries: [], exits: [] };
    }
    if (log.event_type === 'ENTRY') workerMap[wid].entries.push(new Date(log.timestamp_server));
    if (log.event_type === 'EXIT')  workerMap[wid].exits.push(new Date(log.timestamp_server));
  }

  const workers = Object.values(workerMap).map(w => {
    let hours = null;
    if (w.entries.length > 0 && w.exits.length > 0) {
      const lastEntry = w.entries[w.entries.length - 1];
      const lastExit  = w.exits[w.exits.length - 1];
      if (lastExit > lastEntry) {
        hours = Math.round((lastExit - lastEntry) / 3_600_000 * 10) / 10;
      }
    }
    return { id: w.id, name: w.name, hours };
  });

  const machinery = (equipRes.data || []).map(r => ({
    id:   r.equipment_id,
    name: [r.equipment?.model, r.equipment?.plate_or_serial].filter(Boolean).join(' — '),
    type: r.equipment?.type || '',
  }));

  const subcontractors = (subsRes.data || []).map(r => ({
    id:   r.subcontractor_id,
    name: r.subcontractors?.company_name || 'Subappaltatore',
  }));

  // Meteo: usa il log salvato oppure fetch live per date passate
  let weather = null;
  if (weatherLogRes.data) {
    const w = weatherLogRes.data;
    weather = {
      code: w.weather_code, desc: w.weather_desc,
      temp_min: w.temp_min_c, temp_max: w.temp_max_c,
      precipitation_mm: w.precipitation_mm, wind_max_kmh: w.wind_max_kmh,
    };
  } else if (site.latitude && site.longitude) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (date <= today) {
        const w = await getActualWeather(site.latitude, site.longitude, date);
        weather = {
          code: w.weather_code, desc: w.weather_desc,
          temp_min: w.temp_min, temp_max: w.temp_max,
          precipitation_mm: w.precipitation_mm, wind_max_kmh: w.wind_max_kmh,
        };
      }
    } catch { /* meteo non disponibile */ }
  }

  res.json({ workers, machinery, subcontractors, weather });
});

// ── GET /api/v1/sites/:siteId/diary/:date ─────────────────────────────────────
router.get('/sites/:siteId/diary/:date', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'INVALID_DATE' });

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const { data, error } = await supabase
    .from('site_diary_entries').select('*')
    .eq('site_id', siteId).eq('company_id', req.companyId).eq('entry_date', date)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(data);
});

// ── POST /api/v1/sites/:siteId/diary ──────────────────────────────────────────
router.post('/sites/:siteId/diary', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const {
    entry_date,
    weather_code, weather_desc, temp_min, temp_max, precipitation_mm, wind_max_kmh,
    activities, issues, decisions, materials, notes,
    workers_snapshot, machinery_snapshot, subcontractors_snapshot,
    work_hours_total, photos,
  } = req.body;

  if (!entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(entry_date))
    return res.status(400).json({ error: 'MISSING_DATE' });

  const { data, error } = await supabase
    .from('site_diary_entries')
    .upsert({
      company_id:  req.companyId,
      site_id:     siteId,
      entry_date,
      created_by:  req.user?.id ?? null,
      updated_at:  new Date().toISOString(),
      weather_code:    weather_code    ?? null,
      weather_desc:    weather_desc    ?? null,
      temp_min:        temp_min        ?? null,
      temp_max:        temp_max        ?? null,
      precipitation_mm: precipitation_mm ?? null,
      wind_max_kmh:    wind_max_kmh    ?? null,
      activities:  activities  || null,
      issues:      issues      || null,
      decisions:   decisions   || null,
      materials:   materials   || null,
      notes:       notes       || null,
      workers_snapshot:     workers_snapshot     || [],
      machinery_snapshot:   machinery_snapshot   || [],
      subcontractors_snapshot: subcontractors_snapshot || [],
      work_hours_total: work_hours_total ?? null,
      photos:      photos || [],
    }, { onConflict: 'site_id,entry_date' })
    .select().single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.json(data);
});

// ── POST /api/v1/sites/:siteId/diary/photos ───────────────────────────────────
// Carica una foto e restituisce { url, path }
router.post('/sites/:siteId/diary/photos',
  verifySupabaseJwt,
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    const { siteId }  = req.params;
    const { date }    = req.body;

    const site = await getSiteOrFail(siteId, req.companyId, res);
    if (!site) return;
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    const safeDate = (date || new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, '');
    const ext      = path.extname(req.file.originalname) || '.jpg';
    const fileId   = crypto.randomUUID();
    const filePath = `${req.companyId}/diary/${siteId}/${safeDate}/${fileId}${ext}`;

    const { error: storageErr } = await supabase.storage
      .from(BUCKET).upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype, upsert: false,
      });

    if (storageErr) return res.status(500).json({ error: 'UPLOAD_ERROR', detail: storageErr.message });

    const { data: signed } = await supabase.storage
      .from(BUCKET).createSignedUrl(filePath, 60 * 60 * 24 * 365 * 10);

    res.json({ url: signed?.signedUrl || null, path: filePath });
  }
);

// ── DELETE /api/v1/sites/:siteId/diary/photos ──────────────────────────────────
// DEVE stare PRIMA di DELETE /:date — altrimenti Express matcha "photos" come :date
// Elimina una foto dallo storage. Body: { path }
router.delete('/sites/:siteId/diary/photos', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { path: filePath } = req.body;

  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;
  if (!filePath || !String(filePath).startsWith(`${req.companyId}/diary/${siteId}/`))
    return res.status(400).json({ error: 'INVALID_PATH' });

  await supabase.storage.from(BUCKET).remove([filePath]);
  res.json({ ok: true });
});

// ── DELETE /api/v1/sites/:siteId/diary/:date ──────────────────────────────────
router.delete('/sites/:siteId/diary/:date', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const { error } = await supabase
    .from('site_diary_entries').delete()
    .eq('site_id', siteId).eq('company_id', req.companyId).eq('entry_date', date);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── GET /api/v1/sites/:siteId/diary/:date/pdf ─────────────────────────────────
router.get('/sites/:siteId/diary/:date/pdf', verifySupabaseJwt, async (req, res) => {
  const { siteId, date } = req.params;
  const site = await getSiteOrFail(siteId, req.companyId, res);
  if (!site) return;

  const [entryRes, companyRes] = await Promise.all([
    supabase.from('site_diary_entries').select('*')
      .eq('site_id', siteId).eq('company_id', req.companyId).eq('entry_date', date)
      .maybeSingle(),
    supabase.from('companies').select('name').eq('id', req.companyId).maybeSingle(),
  ]);

  if (!entryRes.data) return res.status(404).json({ error: 'NOT_FOUND' });

  const html = buildDiaryPdf(entryRes.data, site, companyRes.data?.name || '');

  try {
    const { renderHtmlToPdf } = require('../../pdf-renderer');
    const pdfBuf = await renderHtmlToPdf(html, { noHeaderFooter: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="diario_${date}.pdf"`);
    res.send(pdfBuf);
  } catch (err) {
    console.error('[diary.pdf]', err.message);
    res.status(500).json({ error: 'PDF_ERROR' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSiteOrFail(siteId, companyId, res) {
  const { data } = await supabase
    .from('sites')
    .select('id, name, address, client, latitude, longitude')
    .eq('id', siteId).eq('company_id', companyId).neq('status', 'eliminato')
    .maybeSingle();
  if (!data) { res.status(404).json({ error: 'SITE_NOT_FOUND_OR_FORBIDDEN' }); return null; }
  return data;
}

function wmoLabel(code) {
  if (code === null || code === undefined) return '—';
  if (code === 0)   return 'Sereno';
  if (code <= 2)    return 'Poco nuvoloso';
  if (code <= 3)    return 'Nuvoloso';
  if (code <= 48)   return 'Nebbia';
  if (code <= 57)   return 'Pioggerella';
  if (code <= 67)   return 'Pioggia';
  if (code <= 77)   return 'Neve';
  if (code <= 82)   return 'Rovesci';
  if (code <= 86)   return 'Rovesci di neve';
  if (code <= 99)   return 'Temporale';
  return '—';
}

function fmtLong(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function buildDiaryPdf(entry, site, companyName) {
  const workers  = Array.isArray(entry.workers_snapshot)      ? entry.workers_snapshot      : [];
  const machinery = Array.isArray(entry.machinery_snapshot)    ? entry.machinery_snapshot    : [];
  const subs     = Array.isArray(entry.subcontractors_snapshot) ? entry.subcontractors_snapshot : [];

  const meteo = [
    entry.weather_desc || wmoLabel(entry.weather_code),
    entry.temp_min != null && entry.temp_max != null ? `${entry.temp_min}°/${entry.temp_max}°C` : null,
    entry.precipitation_mm > 0 ? `${entry.precipitation_mm} mm` : null,
    entry.wind_max_kmh > 0 ? `Vento ${entry.wind_max_kmh} km/h` : null,
  ].filter(Boolean).join(' · ') || '—';

  const workerRows = workers.map(w =>
    `<tr><td>${w.name || '—'}</td><td class="r">${w.hours != null ? w.hours + ' h' : '—'}</td></tr>`
  ).join('');

  const field = (label, val) => val
    ? `<div class="f"><div class="fl">${label}</div><div class="fv">${val}</div></div>`
    : '';

  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:'Helvetica Neue',Arial,sans-serif; font-size:9.5pt; color:#111; }
.page { padding:0 16mm; }
.hdr { padding:8mm 0 5mm; border-bottom:2px solid #1a1a2e; margin-bottom:6mm; display:flex; justify-content:space-between; align-items:flex-end; }
.hl .co { font-size:7.5pt; color:#777; text-transform:uppercase; letter-spacing:1px; font-weight:700; }
.hl h1 { font-size:13pt; font-weight:800; color:#1a1a2e; margin-top:2px; }
.hl .dt { font-size:10pt; font-weight:600; color:#444; margin-top:3px; text-transform:capitalize; }
.hr { text-align:right; font-size:8pt; color:#777; }
.meta { display:flex; gap:4mm; margin-bottom:6mm; }
.mb { flex:1; background:#f5f5f7; border-radius:4px; padding:3mm 4mm; }
.mb .ml { font-size:7pt; text-transform:uppercase; letter-spacing:.5px; color:#888; }
.mb .mv { font-size:9.5pt; font-weight:700; color:#1a1a2e; margin-top:2px; }
.sec { margin-bottom:5mm; }
.sec h2 { font-size:7.5pt; font-weight:700; text-transform:uppercase; letter-spacing:.8px; color:#777; border-bottom:1px solid #e8e8e8; padding-bottom:2px; margin-bottom:3mm; }
.f { padding:2.5mm 0; border-bottom:1px solid #f0f0f0; }
.fl { font-size:7.5pt; color:#888; margin-bottom:1px; }
.fv { font-size:9.5pt; line-height:1.5; white-space:pre-wrap; }
table { width:100%; border-collapse:collapse; font-size:8.5pt; }
th { background:#1a1a2e; color:#fff; padding:3px 5px; text-align:left; font-size:8pt; }
th.r,td.r { text-align:right; }
td { padding:2.5px 5px; border-bottom:1px solid #eee; }
tr:nth-child(even) td { background:#f9f9f9; }
.ft { border-top:1px solid #ddd; padding:3mm 0; display:flex; justify-content:space-between; font-size:7pt; color:#999; margin-top:6mm; }
</style></head><body>
<div class="page">
  <div class="hdr">
    <div class="hl">
      <div class="co">${companyName}</div>
      <h1>Diario di Cantiere · ${site.name}</h1>
      <div class="dt">${fmtLong(entry.entry_date)}</div>
    </div>
    <div class="hr">
      ${site.address ? `<div>${site.address}</div>` : ''}
      ${site.client  ? `<div>Committente: <strong>${site.client}</strong></div>` : ''}
    </div>
  </div>

  <div class="meta">
    <div class="mb"><div class="ml">Meteo</div><div class="mv" style="font-size:8.5pt">${meteo}</div></div>
    <div class="mb"><div class="ml">Lavoratori</div><div class="mv">${workers.length}</div></div>
    <div class="mb"><div class="ml">Ore totali</div><div class="mv">${entry.work_hours_total != null ? entry.work_hours_total + ' h' : '—'}</div></div>
    <div class="mb"><div class="ml">Subappaltatori</div><div class="mv">${subs.length}</div></div>
  </div>

  ${workers.length ? `<div class="sec"><h2>Lavoratori presenti</h2>
    <table><thead><tr><th>Nominativo</th><th class="r">Ore</th></tr></thead>
    <tbody>${workerRows}</tbody></table></div>` : ''}

  ${machinery.length ? `<div class="sec"><h2>Mezzi e attrezzature</h2>
    <div class="f"><div class="fv">${machinery.map(m => m.name || m.id).join(' · ')}</div></div></div>` : ''}

  ${subs.length ? `<div class="sec"><h2>Subappaltatori</h2>
    <div class="f"><div class="fv">${subs.map(s => s.name || s.id).join(' · ')}</div></div></div>` : ''}

  <div class="sec"><h2>Attività e annotazioni</h2>
    ${field('Lavori eseguiti', entry.activities)}
    ${field('Problemi riscontrati', entry.issues)}
    ${field('Decisioni / Istruzioni DL', entry.decisions)}
    ${field('Materiali consegnati / utilizzati', entry.materials)}
    ${field('Note libere', entry.notes)}
    ${!entry.activities && !entry.issues && !entry.decisions && !entry.materials && !entry.notes
      ? '<div class="f"><div class="fv" style="color:#aaa">Nessuna annotazione</div></div>' : ''}
  </div>

  <div class="ft">
    <span>Palladia · Diario di Cantiere</span>
    <span>Generato il ${new Date().toLocaleString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}</span>
  </div>
</div></body></html>`;
}

module.exports = router;
