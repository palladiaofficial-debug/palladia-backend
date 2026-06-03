'use strict';
/**
 * routes/v1/economia.js
 * SAL — Stato Avanzamento Lavori: budget, costi, ricavi per cantiere.
 *
 * GET    /api/v1/sites/:siteId/economia                   — riepilogo + voci
 * PATCH  /api/v1/sites/:siteId/economia/settings          — aggiorna budget + SAL %
 * POST   /api/v1/sites/:siteId/economia/voci              — aggiungi voce
 * PATCH  /api/v1/sites/:siteId/economia/voci/:id          — modifica voce
 * DELETE /api/v1/sites/:siteId/economia/voci/:id          — elimina voce
 * GET    /api/v1/sites/:siteId/economia/sal-pdf           — PDF on-demand
 * GET    /api/v1/sites/:siteId/economia/sal-history       — storico SAL
 * POST   /api/v1/sites/:siteId/economia/sal-history       — emetti + salva SAL
 * DELETE /api/v1/sites/:siteId/economia/sal-history/:id  — elimina SAL
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { validate } = require('../../middleware/validate');
const {
  patchEconomiaSettingsSchema,
  createVoceSchema,
  patchVoceSchema,
  createSalHistorySchema,
  patchSalHistorySchema,
} = require('../../lib/schemas/economia');

router.use(verifySupabaseJwt);

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const STORAGE_BUCKET = 'site-media';
const SIGNED_URL_TTL = 3600; // 1h

// Verifica che il cantiere appartenga alla company dell'utente
async function resolveSite(siteId, companyId) {
  if (!isUuid(siteId)) return null;
  const { data } = await supabase
    .from('sites')
    .select('id, budget_totale, sal_percentuale')
    .eq('id', siteId)
    .eq('company_id', companyId)
    .maybeSingle();
  return data;
}

// ── GET /api/v1/sites/:siteId/economia ───────────────────────────────────────

router.get('/sites/:siteId/economia', async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { data: voci, error } = await supabase
    .from('site_economia_voci')
    .select('id, tipo, categoria, voce, importo, data_competenza, note, created_at')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .order('data_competenza', { ascending: false })
    .order('created_at',      { ascending: false });

  if (error) {
    console.error('[economia/get]', error.message);
    return res.status(500).json({ error: 'INTERNAL' });
  }

  const costi   = (voci || []).filter(v => v.tipo === 'costo');
  const ricavi  = (voci || []).filter(v => v.tipo === 'ricavo');
  const totCosti  = costi.reduce((s, v)  => s + Number(v.importo), 0);
  const totRicavi = ricavi.reduce((s, v) => s + Number(v.importo), 0);
  const utile     = totRicavi - totCosti;

  const costiPerCategoria   = {};
  const ricaviPerCategoria  = {};
  costi.forEach(v  => { costiPerCategoria[v.categoria]  = (costiPerCategoria[v.categoria]  || 0) + Number(v.importo); });
  ricavi.forEach(v => { ricaviPerCategoria[v.categoria] = (ricaviPerCategoria[v.categoria] || 0) + Number(v.importo); });

  res.json({
    settings: {
      budget_totale:   site.budget_totale   !== null ? Number(site.budget_totale)   : null,
      sal_percentuale: site.sal_percentuale !== null ? Number(site.sal_percentuale) : 0,
    },
    summary: {
      totale_costi:  totCosti,
      totale_ricavi: totRicavi,
      utile,
      margine_percentuale: totRicavi > 0 ? Math.round((utile / totRicavi) * 100) : null,
    },
    voci: voci || [],
    costi_per_categoria:  costiPerCategoria,
    ricavi_per_categoria: ricaviPerCategoria,
  });
});

// ── PATCH /api/v1/sites/:siteId/economia/settings ────────────────────────────

router.patch('/sites/:siteId/economia/settings', validate(patchEconomiaSettingsSchema), async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { budget_totale, sal_percentuale } = req.body;

  const patch = {};

  if (budget_totale !== undefined) {
    const n = parseFloat(budget_totale);
    if (isNaN(n) || n < 0) return res.status(400).json({ error: 'budget_totale non valido' });
    patch.budget_totale = n;
  }

  if (sal_percentuale !== undefined) {
    const n = parseFloat(sal_percentuale);
    if (isNaN(n) || n < 0 || n > 100) return res.status(400).json({ error: 'sal_percentuale deve essere 0–100' });
    patch.sal_percentuale = n;
  }

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

  const { error } = await supabase.from('sites').update(patch).eq('id', siteId).eq('company_id', companyId);
  if (error) return res.status(500).json({ error: 'INTERNAL', detail: error.message });

  res.json({ ok: true, ...patch });
});

// ── POST /api/v1/sites/:siteId/economia/voci ─────────────────────────────────

router.post('/sites/:siteId/economia/voci', validate(createVoceSchema), async (req, res) => {
  const { companyId, user } = req;
  const { siteId }          = req.params;

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { tipo, categoria, voce, importo, data_competenza, note } = req.body;

  if (!['costo', 'ricavo'].includes(tipo))
    return res.status(400).json({ error: 'tipo deve essere costo o ricavo' });
  if (!categoria || !String(categoria).trim())
    return res.status(400).json({ error: 'categoria obbligatoria' });
  if (!voce || !String(voce).trim())
    return res.status(400).json({ error: 'voce obbligatoria' });

  const imp = parseFloat(importo);
  if (isNaN(imp) || imp <= 0)
    return res.status(400).json({ error: 'importo deve essere > 0' });

  if (data_competenza && !/^\d{4}-\d{2}-\d{2}$/.test(data_competenza))
    return res.status(400).json({ error: 'data_competenza deve essere YYYY-MM-DD' });

  const { data: voce_creata, error } = await supabase
    .from('site_economia_voci')
    .insert({
      company_id:      companyId,
      site_id:         siteId,
      tipo,
      categoria:       String(categoria).trim(),
      voce:            String(voce).trim().slice(0, 300),
      importo:         imp,
      data_competenza: data_competenza || new Date().toISOString().slice(0, 10),
      note:            note ? String(note).trim().slice(0, 1000) : null,
      created_by:      user.id,
    })
    .select()
    .single();

  if (error) {
    console.error('[economia/post-voce]', error.message);
    return res.status(500).json({ error: 'INTERNAL' });
  }

  res.status(201).json(voce_creata);
});

// ── PATCH /api/v1/sites/:siteId/economia/voci/:id ────────────────────────────

router.patch('/sites/:siteId/economia/voci/:id', validate(patchVoceSchema), async (req, res) => {
  const { companyId } = req;
  const { siteId, id } = req.params;

  if (!isUuid(id)) return res.status(400).json({ error: 'id non valido' });

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const patch = {};
  const { tipo, categoria, voce, importo, data_competenza, note } = req.body;

  if (tipo !== undefined) {
    if (!['costo', 'ricavo'].includes(tipo)) return res.status(400).json({ error: 'tipo non valido' });
    patch.tipo = tipo;
  }
  if (categoria !== undefined) patch.categoria = String(categoria).trim();
  if (voce      !== undefined) patch.voce      = String(voce).trim().slice(0, 300);
  if (note      !== undefined) patch.note       = note ? String(note).trim().slice(0, 1000) : null;
  if (importo   !== undefined) {
    const imp = parseFloat(importo);
    if (isNaN(imp) || imp <= 0) return res.status(400).json({ error: 'importo deve essere > 0' });
    patch.importo = imp;
  }
  if (data_competenza !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data_competenza)) return res.status(400).json({ error: 'data_competenza YYYY-MM-DD' });
    patch.data_competenza = data_competenza;
  }

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nessun campo da aggiornare' });

  const { error } = await supabase
    .from('site_economia_voci')
    .update(patch)
    .eq('id', id)
    .eq('site_id', siteId)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: 'INTERNAL', detail: error.message });

  res.json({ ok: true });
});

// ── DELETE /api/v1/sites/:siteId/economia/voci/:id ───────────────────────────

router.delete('/sites/:siteId/economia/voci/:id', async (req, res) => {
  const { companyId } = req;
  const { siteId, id } = req.params;

  if (!isUuid(id)) return res.status(400).json({ error: 'id non valido' });

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { error } = await supabase
    .from('site_economia_voci')
    .delete()
    .eq('id', id)
    .eq('site_id', siteId)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: 'INTERNAL', detail: error.message });

  res.json({ ok: true });
});

// ── Shared P&L calculation ────────────────────────────────────────────────────
async function calcPnl(siteId, companyId, site) {
  const [computoRes, logsRes, costsRes, workersRes] = await Promise.all([
    supabase.from('site_computo')
      .select('id, totale_contratto')
      .eq('site_id', siteId).eq('company_id', companyId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('presence_logs')
      .select('worker_id, event_type, timestamp_server')
      .eq('site_id', siteId).eq('company_id', companyId)
      .order('worker_id').order('timestamp_server'),
    supabase.from('site_costs')
      .select('id, descrizione, fornitore, importo, tipo, categoria, data_documento, numero_documento')
      .eq('site_id', siteId).eq('company_id', companyId)
      .order('categoria').order('data_documento', { ascending: false }),
    supabase.from('workers')
      .select('id, full_name, tariffa_oraria')
      .eq('company_id', companyId),
  ]);

  // 1. Contratto
  let source = 'none', totale_contratto = null, importo_maturato = null, sal_percentuale = 0;

  if (computoRes.data?.id) {
    source = 'computo';
    totale_contratto = computoRes.data.totale_contratto
      ? Number(computoRes.data.totale_contratto) : null;
    const { data: voci } = await supabase
      .from('site_computo_voci')
      .select('importo, sal_percentuale')
      .eq('computo_id', computoRes.data.id).eq('tipo', 'voce');
    const allVoci    = voci || [];
    const sumImporti = allVoci.reduce((s, v) => s + Number(v.importo || 0), 0);
    const maturato   = allVoci.reduce((s, v) =>
      s + Number(v.importo || 0) * Number(v.sal_percentuale || 0) / 100, 0);
    importo_maturato = Math.round(maturato * 100) / 100;
    sal_percentuale  = sumImporti > 0
      ? Math.round((maturato / sumImporti) * 1000) / 10 : 0;
  } else if (site.budget_totale !== null) {
    source = 'manual';
    totale_contratto = Number(site.budget_totale);
    sal_percentuale  = Number(site.sal_percentuale) || 0;
    importo_maturato = Math.round(totale_contratto * sal_percentuale / 100 * 100) / 100;
  }

  // 2. Costo manodopera
  const workerMap = {};
  for (const w of (workersRes.data || [])) workerMap[w.id] = w;

  const sessions = {};
  for (const log of (logsRes.data || [])) {
    const wid = log.worker_id;
    if (!sessions[wid]) sessions[wid] = { pending: null, hours: 0 };
    const s = sessions[wid];
    if (log.event_type === 'ENTRY') {
      s.pending = new Date(log.timestamp_server).getTime();
    } else if (log.event_type === 'EXIT' && s.pending) {
      const h = (new Date(log.timestamp_server).getTime() - s.pending) / 3600000;
      s.hours += Math.max(0, Math.min(h, 24));
      s.pending = null;
    }
  }

  let totale_mo = 0, workers_no_tariffa = 0;
  const mo_breakdown = [];
  for (const [wid, s] of Object.entries(sessions)) {
    if (s.hours < 0.01) continue;
    const w = workerMap[wid];
    if (!w) continue;
    const t = parseFloat(w.tariffa_oraria) || 0;
    if (!t) workers_no_tariffa++;
    const costo = Math.round(s.hours * t * 100) / 100;
    totale_mo  += costo;
    mo_breakdown.push({
      worker_id:      wid,
      full_name:      w.full_name,
      ore_totali:     Math.round(s.hours * 100) / 100,
      tariffa_oraria: t,
      costo_totale:   costo,
    });
  }
  mo_breakdown.sort((a, b) => b.ore_totali - a.ore_totali);
  totale_mo = Math.round(totale_mo * 100) / 100;

  // 3. Costi diretti
  const costs = costsRes.data || [];
  const totale_diretti = Math.round(
    costs.reduce((s, c) => s + Number(c.importo || 0), 0) * 100) / 100;
  const per_tipo = {}, per_categoria = {};
  for (const c of costs) {
    per_tipo[c.tipo] = (per_tipo[c.tipo] || 0) + Number(c.importo);
    const cat = c.categoria || 'Altro';
    per_categoria[cat] = (per_categoria[cat] || 0) + Number(c.importo);
  }

  // 4. P&L
  const totale_costi = Math.round((totale_mo + totale_diretti) * 100) / 100;
  const margine      = importo_maturato !== null
    ? Math.round((importo_maturato - totale_costi) * 100) / 100 : null;
  const margine_pct  = margine !== null && importo_maturato > 0
    ? Math.round((margine / importo_maturato) * 1000) / 10 : null;

  return {
    source,
    settings: {
      budget_totale:   site.budget_totale !== null ? Number(site.budget_totale) : null,
      sal_percentuale: Number(site.sal_percentuale) || 0,
    },
    contratto: { totale_contratto, importo_maturato, sal_percentuale },
    costo_mo:  { totale: totale_mo, breakdown: mo_breakdown, workers_no_tariffa },
    costi_diretti: { totale: totale_diretti, per_tipo, per_categoria, rows: costs },
    margine:   { valore: margine, percentuale: margine_pct },
    totale_costi,
  };
}

// ── GET /api/v1/sites/:siteId/economia/pnl ───────────────────────────────────
router.get('/sites/:siteId/economia/pnl', async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;
  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
  const pnl = await calcPnl(siteId, companyId, site);
  const { costi_diretti: { rows, ...costiSummary }, ...rest } = pnl;
  res.json({ ...rest, costi_diretti: costiSummary });
});

// ── Shared PDF HTML builder ───────────────────────────────────────────────────
function buildSalPdfHtml({ siteName, siteAddress, client, companyName, pnl, salNumber, dataEmissione }) {
  const { contratto, costo_mo, costi_diretti, margine, totale_costi } = pnl;
  const salPct   = contratto.sal_percentuale;
  const maturato = contratto.importo_maturato;

  function fmtEur(n) {
    if (n == null) return '—';
    return '€ ' + Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtOre(h) {
    const hh = Math.floor(h); const mm = Math.round((h - hh) * 60);
    return `${hh}h${mm > 0 ? ` ${mm}m` : ''}`;
  }

  const costiPerCat = {};
  for (const c of (costi_diretti.rows || [])) {
    const cat = c.categoria || 'Altro';
    if (!costiPerCat[cat]) costiPerCat[cat] = [];
    costiPerCat[cat].push(c);
  }

  function costiRows() {
    if (!costi_diretti.rows?.length) return '<tr><td colspan="4" style="padding:12px 16px;color:#6b7280;font-style:italic;font-size:11px">Nessun costo diretto registrato</td></tr>';
    let html = '';
    for (const [cat, items] of Object.entries(costiPerCat)) {
      const tot = items.reduce((s, i) => s + Number(i.importo), 0);
      html += `<tr style="background:#f9fafb"><td colspan="3" style="padding:7px 16px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#374151">${cat}</td><td style="padding:7px 16px;text-align:right;font-size:10px;font-weight:700;color:#374151">${fmtEur(tot)}</td></tr>`;
      for (const c of items) {
        html += `<tr><td style="padding:6px 16px 6px 28px;font-size:11px;color:#374151;border-bottom:1px solid #f3f4f6">${c.descrizione}</td><td style="padding:6px 8px;font-size:11px;color:#6b7280;border-bottom:1px solid #f3f4f6">${c.fornitore || '—'}</td><td style="padding:6px 8px;font-size:11px;color:#6b7280;border-bottom:1px solid #f3f4f6">${c.data_documento ? new Date(c.data_documento+'T12:00:00').toLocaleDateString('it-IT') : '—'}</td><td style="padding:6px 16px;text-align:right;font-size:11px;color:#374151;border-bottom:1px solid #f3f4f6">${fmtEur(Number(c.importo))}</td></tr>`;
      }
    }
    return html;
  }

  function moRows() {
    if (!costo_mo.breakdown.length) return '<tr><td colspan="4" style="padding:12px 16px;color:#6b7280;font-style:italic;font-size:11px">Nessuna timbratura registrata</td></tr>';
    return costo_mo.breakdown.map(w => `<tr><td style="padding:7px 16px;font-size:11px;color:#374151;border-bottom:1px solid #f3f4f6">${w.full_name}</td><td style="padding:7px 8px;text-align:right;font-size:11px;color:#6b7280;border-bottom:1px solid #f3f4f6">${fmtOre(w.ore_totali)}</td><td style="padding:7px 8px;text-align:right;font-size:11px;color:#6b7280;border-bottom:1px solid #f3f4f6">${w.tariffa_oraria ? `€ ${w.tariffa_oraria.toFixed(2)}/h` : '<i>N/D</i>'}</td><td style="padding:7px 16px;text-align:right;font-size:11px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6">${w.costo_totale > 0 ? fmtEur(w.costo_totale) : '<span style="color:#d97706">N/D</span>'}</td></tr>`).join('');
  }

  const salLabel    = salNumber != null ? `SAL N. ${salNumber}` : 'SAL';
  const margineClass = margine.valore == null ? '' : margine.valore >= 0 ? 'green' : 'red';

  return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#111827;background:#fff;font-size:12px}
.page{padding:12mm 14mm 10mm}
.header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:10px;border-bottom:2.5px solid #111827;margin-bottom:16px}
.header-left h1{font-size:20px;font-weight:800;letter-spacing:-.02em}
.header-left p{font-size:11px;color:#6b7280;margin-top:2px}
.badge{display:inline-block;background:#111827;color:#fff;font-size:9px;font-weight:700;padding:2px 9px;border-radius:20px;letter-spacing:.08em;text-transform:uppercase}
.date{font-size:10px;color:#6b7280;margin-top:4px;text-align:right}
.section{margin-bottom:16px}
.section-title{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #e5e7eb}
.info-grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px}
.info-item label{font-size:9px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:2px}
.info-item span{font-size:12px;font-weight:600;color:#111827}
.kpi-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
.kpi{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px}
.kpi label{font-size:9px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:3px}
.kpi .val{font-size:15px;font-weight:800;color:#111827}
.kpi .sub{font-size:9px;color:#9ca3af;margin-top:2px}
.kpi.accent{background:#111827;border-color:#111827}
.kpi.accent label,.kpi.accent .sub{color:#9ca3af}
.kpi.accent .val{color:#fff}
.kpi.green{background:#f0fdf4;border-color:#bbf7d0}
.kpi.green .val{color:#15803d}
.kpi.red{background:#fef2f2;border-color:#fecaca}
.kpi.red .val{color:#dc2626}
.progress-bar{background:#e5e7eb;border-radius:99px;height:8px;overflow:hidden;margin:8px 0 3px}
.progress-fill{height:100%;border-radius:99px;background:#111827}
table{width:100%;border-collapse:collapse}
.tbl-head{background:#111827}
.tbl-head th{padding:7px 16px;font-size:10px;font-weight:700;color:#fff;text-align:left}
.tbl-foot{background:#f1f5f9}
.tbl-foot td{padding:8px 16px;font-size:11px;font-weight:700;color:#111827}
.signature-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:24px}
.sig-box{border-top:1.5px solid #e5e7eb;padding-top:8px}
.sig-box label{font-size:9px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em}
.doc-footer{margin-top:12px;padding:6px 0;font-size:8px;color:#9ca3af;display:flex;justify-content:space-between;border-top:1px solid #e5e7eb}
@page{size:A4;margin:0}
</style></head><body>
<div class="page">

<div class="header">
  <div class="header-left">
    <h1>${companyName || 'Impresa'}</h1>
    <p>Stato Avanzamento Lavori &mdash; ${siteName}</p>
  </div>
  <div>
    <div class="badge">${salLabel}</div>
    <div class="date">Emesso il ${dataEmissione}</div>
  </div>
</div>

<div class="section">
  <div class="section-title">Dati cantiere</div>
  <div class="info-grid">
    <div class="info-item"><label>Cantiere</label><span>${siteName}</span></div>
    <div class="info-item"><label>Committente</label><span>${client || '—'}</span></div>
    <div class="info-item"><label>Indirizzo</label><span>${siteAddress || '—'}</span></div>
    <div class="info-item"><label>Impresa esecutrice</label><span>${companyName || '—'}</span></div>
  </div>
</div>

<div class="section">
  <div class="section-title">Riepilogo economico</div>
  <div class="kpi-grid">
    <div class="kpi">
      <label>Contratto</label>
      <div class="val">${fmtEur(contratto.totale_contratto)}</div>
      <div class="sub">valore appalto</div>
    </div>
    <div class="kpi accent">
      <label>Avanzamento</label>
      <div class="val">${salPct.toFixed(1)}%</div>
      <div class="sub">SAL corrente</div>
    </div>
    <div class="kpi">
      <label>Importo maturato</label>
      <div class="val">${fmtEur(maturato)}</div>
      <div class="sub">al ${salPct.toFixed(1)}%</div>
    </div>
    <div class="kpi">
      <label>Costi totali</label>
      <div class="val">${fmtEur(totale_costi)}</div>
      <div class="sub">MO + diretti</div>
    </div>
    <div class="kpi ${margineClass}">
      <label>Margine</label>
      <div class="val">${fmtEur(margine.valore)}</div>
      <div class="sub">${margine.percentuale != null ? `${margine.percentuale.toFixed(1)}% sul maturato` : 'dati incompleti'}</div>
    </div>
  </div>
  ${contratto.totale_contratto ? `
  <div style="margin-top:10px">
    <div style="display:flex;justify-content:space-between;font-size:10px;color:#6b7280;margin-bottom:3px">
      <span>Avanzamento lavori</span><span>${salPct.toFixed(1)}%</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(salPct,100)}%"></div></div>
    <div style="font-size:9px;color:#9ca3af">${fmtEur(maturato)} maturati su ${fmtEur(contratto.totale_contratto)} contrattuali</div>
  </div>` : ''}
</div>

<div class="section">
  <div class="section-title">Costi diretti (fatture, DDT, subappalti)</div>
  <table>
    <thead class="tbl-head">
      <tr>
        <th>Descrizione</th>
        <th>Fornitore</th>
        <th>Data doc.</th>
        <th style="text-align:right">Importo</th>
      </tr>
    </thead>
    <tbody>${costiRows()}</tbody>
    <tfoot class="tbl-foot">
      <tr>
        <td colspan="3">Totale costi diretti</td>
        <td style="text-align:right">${fmtEur(costi_diretti.totale)}</td>
      </tr>
    </tfoot>
  </table>
</div>

<div class="section">
  <div class="section-title">Costo manodopera (da timbrature badge)</div>
  <table>
    <thead class="tbl-head">
      <tr>
        <th>Lavoratore</th>
        <th style="text-align:right">Ore totali</th>
        <th style="text-align:right">Tariffa/h</th>
        <th style="text-align:right">Costo</th>
      </tr>
    </thead>
    <tbody>${moRows()}</tbody>
    <tfoot class="tbl-foot">
      <tr>
        <td colspan="3">Totale manodopera</td>
        <td style="text-align:right">${fmtEur(costo_mo.totale)}</td>
      </tr>
    </tfoot>
  </table>
  ${costo_mo.workers_no_tariffa > 0 ? `<p style="font-size:9px;color:#d97706;margin-top:5px">⚠ ${costo_mo.workers_no_tariffa} lavorator${costo_mo.workers_no_tariffa>1?'i':''} senza tariffa oraria — costo parzialmente stimato.</p>` : ''}
</div>

<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin-bottom:16px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b7280">Totale costi</span>
    <span style="font-size:15px;font-weight:800">${fmtEur(totale_costi)}</span>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b7280">Importo maturato</span>
    <span style="font-size:15px;font-weight:800">${fmtEur(maturato)}</span>
  </div>
  <div style="border-top:1px solid #e5e7eb;padding-top:6px;display:flex;justify-content:space-between;align-items:center">
    <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${margine.valore == null ? '#9ca3af' : margine.valore >= 0 ? '#15803d' : '#dc2626'}">Margine</span>
    <span style="font-size:17px;font-weight:800;color:${margine.valore == null ? '#9ca3af' : margine.valore >= 0 ? '#15803d' : '#dc2626'}">${fmtEur(margine.valore)}${margine.percentuale != null ? ` <span style="font-size:12px;font-weight:600">(${margine.percentuale.toFixed(1)}%)</span>` : ''}</span>
  </div>
</div>

<div class="signature-grid">
  <div class="sig-box">
    <label>Firma Direttore Lavori</label>
    <div style="height:36px"></div>
  </div>
  <div class="sig-box">
    <label>Firma Impresa esecutrice (${companyName || '—'})</label>
    <div style="height:36px"></div>
  </div>
</div>

<div class="doc-footer">
  <span>${siteName} &mdash; ${salLabel} emesso il ${dataEmissione}</span>
  <span>Generato con Palladia &mdash; palladia.it</span>
</div>
</div></body></html>`;
}

// ── GET /api/v1/sites/:siteId/economia/sal-pdf ───────────────────────────────
router.get('/sites/:siteId/economia/sal-pdf', async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const [{ data: siteData }, { data: company }, pnl] = await Promise.all([
    supabase.from('sites').select('name, address, client').eq('id', siteId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    calcPnl(siteId, companyId, site),
  ]);

  const siteName    = siteData?.name    || 'Cantiere';
  const siteAddress = siteData?.address || '';
  const client      = siteData?.client  || '';
  const companyName = company?.name     || '';
  const now         = new Date();
  const dataEmissione = now.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const safeName    = siteName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);

  const html = buildSalPdfHtml({ siteName, siteAddress, client, companyName, pnl, salNumber: null, dataEmissione });

  try {
    const { rendererPool } = require('../../pdf-renderer');
    const pdfBuffer = await rendererPool.render(html, {
      docTitle: `SAL — ${siteName}`,
      revision:  1,
      noHeaderFooter: true,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="SAL-${safeName}-${now.toISOString().slice(0,10)}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    console.error('[economia/sal-pdf]', e.message);
    res.status(500).json({ error: 'PDF_GENERATION_ERROR', detail: e.message });
  }
});

// ── GET /api/v1/sites/:siteId/economia/sal-history ───────────────────────────
router.get('/sites/:siteId/economia/sal-history', async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { data: rows, error } = await supabase
    .from('site_sal_history')
    .select('*')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .order('sal_number', { ascending: false });

  if (error) {
    console.error('[sal-history/get]', error.message);
    return res.status(500).json({ error: 'INTERNAL' });
  }

  // Generate signed URLs for each PDF
  const result = await Promise.all((rows || []).map(async row => {
    let pdf_signed_url = null;
    if (row.pdf_url) {
      const { data: signed } = await supabase.storage
        .from(STORAGE_BUCKET)
        .createSignedUrl(row.pdf_url, SIGNED_URL_TTL);
      pdf_signed_url = signed?.signedUrl ?? null;
    }
    return { ...row, pdf_signed_url };
  }));

  res.json({ sal_history: result });
});

// ── POST /api/v1/sites/:siteId/economia/sal-history ──────────────────────────
router.post('/sites/:siteId/economia/sal-history', validate(createSalHistorySchema), async (req, res) => {
  const { companyId, user } = req;
  const { siteId }          = req.params;
  const { note }            = req.body;

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  // Determine next SAL number for this site
  const { data: lastSal } = await supabase
    .from('site_sal_history')
    .select('sal_number')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .order('sal_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  const salNumber = (lastSal?.sal_number ?? 0) + 1;

  // Fetch P&L + site info in parallel
  const [{ data: siteData }, { data: company }, pnl] = await Promise.all([
    supabase.from('sites').select('name, address, client').eq('id', siteId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    calcPnl(siteId, companyId, site),
  ]);

  const siteName    = siteData?.name    || 'Cantiere';
  const siteAddress = siteData?.address || '';
  const client      = siteData?.client  || '';
  const companyName = company?.name     || '';
  const now         = new Date();
  const dateISO     = now.toISOString().slice(0, 10);
  const dataEmissione = now.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });

  // Generate PDF
  const html = buildSalPdfHtml({ siteName, siteAddress, client, companyName, pnl, salNumber, dataEmissione });

  let pdfBuffer;
  try {
    const { rendererPool } = require('../../pdf-renderer');
    pdfBuffer = await rendererPool.render(html, {
      docTitle: `SAL N.${salNumber} — ${siteName}`,
      revision: salNumber,
      noHeaderFooter: true,
    });
  } catch (e) {
    console.error('[sal-history/post] PDF error', e.message);
    return res.status(500).json({ error: 'PDF_GENERATION_ERROR', detail: e.message });
  }

  // Upload PDF to storage
  const salNumPadded = String(salNumber).padStart(2, '0');
  const storagePath  = `${companyId}/${siteId}/sal/SAL-${salNumPadded}-${dateISO}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, pdfBuffer, {
      contentType:  'application/pdf',
      upsert:       false,
    });

  if (uploadError) {
    console.error('[sal-history/post] Storage upload error', uploadError.message);
    return res.status(500).json({ error: 'STORAGE_ERROR', detail: uploadError.message });
  }

  // Scadenza incasso: +30 giorni dall'emissione
  const paymentDue = new Date(now);
  paymentDue.setDate(paymentDue.getDate() + 30);
  const dataPagamentoPrevista = paymentDue.toISOString().slice(0, 10);

  // Save snapshot row
  const { contratto, costo_mo, costi_diretti, margine, totale_costi } = pnl;
  const { data: row, error: insertError } = await supabase
    .from('site_sal_history')
    .insert({
      company_id:              companyId,
      site_id:                 siteId,
      sal_number:              salNumber,
      sal_percentuale:         contratto.sal_percentuale,
      data_emissione:          dateISO,
      totale_contratto:        contratto.totale_contratto,
      importo_maturato:        contratto.importo_maturato,
      costo_mo:                costo_mo.totale,
      costi_diretti:           costi_diretti.totale,
      totale_costi,
      margine:                 margine.valore,
      margine_percentuale:     margine.percentuale,
      note:                    note ? String(note).trim().slice(0, 1000) : null,
      pdf_url:                 storagePath,
      created_by:              user.id,
      data_pagamento_prevista: dataPagamentoPrevista,
    })
    .select()
    .single();

  if (insertError) {
    console.error('[sal-history/post] Insert error', insertError.message);
    // Attempt cleanup of uploaded PDF
    await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
    return res.status(500).json({ error: 'INTERNAL', detail: insertError.message });
  }

  // Return with signed URL
  const { data: signed } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL);

  res.status(201).json({ ...row, pdf_signed_url: signed?.signedUrl ?? null });
});

// ── PATCH /api/v1/sites/:siteId/economia/sal-history/:id ─────────────────────
// Marca come incassato (pagato_il = oggi) o annulla (pagato_il = null).
router.patch('/sites/:siteId/economia/sal-history/:id', validate(patchSalHistorySchema), async (req, res) => {
  const { companyId } = req;
  const { siteId, id } = req.params;

  if (!isUuid(id)) return res.status(400).json({ error: 'id non valido' });

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { pagato_il } = req.body;

  // pagato_il può essere una data YYYY-MM-DD oppure null
  let value = null;
  if (pagato_il !== null && pagato_il !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pagato_il)) {
      return res.status(400).json({ error: 'pagato_il deve essere YYYY-MM-DD o null' });
    }
    value = pagato_il;
  }

  const { error } = await supabase
    .from('site_sal_history')
    .update({ pagato_il: value })
    .eq('id', id)
    .eq('site_id', siteId)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: 'INTERNAL', detail: error.message });
  res.json({ ok: true, pagato_il: value });
});

// ── DELETE /api/v1/sites/:siteId/economia/sal-history/:id ────────────────────
router.delete('/sites/:siteId/economia/sal-history/:id', async (req, res) => {
  const { companyId } = req;
  const { siteId, id } = req.params;

  if (!isUuid(id)) return res.status(400).json({ error: 'id non valido' });

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  // Fetch the row first to get pdf_url
  const { data: row, error: fetchErr } = await supabase
    .from('site_sal_history')
    .select('id, pdf_url')
    .eq('id', id)
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (fetchErr || !row) return res.status(404).json({ error: 'NOT_FOUND' });

  // Delete PDF from storage
  if (row.pdf_url) {
    const { error: storageErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove([row.pdf_url]);
    if (storageErr) console.error('[sal-history/delete] Storage remove error', storageErr.message);
  }

  // Delete the row
  const { error } = await supabase
    .from('site_sal_history')
    .delete()
    .eq('id', id)
    .eq('site_id', siteId)
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ error: 'INTERNAL', detail: error.message });

  res.json({ ok: true });
});

module.exports = router;
