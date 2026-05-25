'use strict';
/**
 * routes/v1/economia.js
 * SAL — Stato Avanzamento Lavori: budget, costi, ricavi per cantiere.
 *
 * GET    /api/v1/sites/:siteId/economia           — riepilogo + voci
 * PATCH  /api/v1/sites/:siteId/economia/settings  — aggiorna budget + SAL %
 * POST   /api/v1/sites/:siteId/economia/voci      — aggiungi voce
 * PATCH  /api/v1/sites/:siteId/economia/voci/:id  — modifica voce
 * DELETE /api/v1/sites/:siteId/economia/voci/:id  — elimina voce
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

router.use(verifySupabaseJwt);

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

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

  // Aggregazione per categoria
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

router.patch('/sites/:siteId/economia/settings', async (req, res) => {
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

router.post('/sites/:siteId/economia/voci', async (req, res) => {
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

router.patch('/sites/:siteId/economia/voci/:id', async (req, res) => {
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

// ── GET /api/v1/sites/:siteId/economia/pnl ───────────────────────────────────
// P&L completo per cantiere: contratto, costo MO auto, costi diretti, margine.

router.get('/sites/:siteId/economia/pnl', async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  // Fetch parallelo: computo + timbrature + costi + lavoratori
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
      .select('importo, tipo, categoria')
      .eq('site_id', siteId).eq('company_id', companyId),
    supabase.from('workers')
      .select('id, full_name, tariffa_oraria')
      .eq('company_id', companyId),
  ]);

  // 1. Contratto (da ComputoTab → fallback su budget manuale)
  let totale_contratto = null, importo_maturato = null, sal_percentuale = 0;

  if (computoRes.data?.id) {
    totale_contratto = computoRes.data.totale_contratto
      ? Number(computoRes.data.totale_contratto) : null;

    const { data: voci } = await supabase
      .from('site_computo_voci')
      .select('importo, sal_percentuale')
      .eq('computo_id', computoRes.data.id).eq('tipo', 'voce');

    const allVoci = voci || [];
    const sumImporti = allVoci.reduce((s, v) => s + Number(v.importo || 0), 0);
    const maturato   = allVoci.reduce((s, v) =>
      s + Number(v.importo || 0) * Number(v.sal_percentuale || 0) / 100, 0);
    importo_maturato = Math.round(maturato * 100) / 100;
    sal_percentuale  = sumImporti > 0
      ? Math.round((maturato / sumImporti) * 1000) / 10 : 0;

  } else if (site.budget_totale !== null) {
    totale_contratto = Number(site.budget_totale);
    sal_percentuale  = Number(site.sal_percentuale) || 0;
    importo_maturato = Math.round(totale_contratto * sal_percentuale / 100 * 100) / 100;
  }

  // 2. Costo manodopera: accoppia ENTRY/EXIT per lavoratore
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
      s.hours += Math.max(0, Math.min(h, 24)); // cap 24h per sessione (anti-anomalie)
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
    totale_mo += costo;
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

  // 3. Costi diretti (da site_costs)
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

  res.json({
    contratto: { totale_contratto, importo_maturato, sal_percentuale },
    costo_mo:  { totale: totale_mo, breakdown: mo_breakdown, workers_no_tariffa },
    costi_diretti: { totale: totale_diretti, per_tipo, per_categoria },
    margine:   { valore: margine, percentuale: margine_pct },
    totale_costi,
  });
});

// ── GET /api/v1/sites/:siteId/economia/sal-pdf ───────────────────────────────
// Genera il PDF del SAL da scaricare e inviare al committente.

router.get('/sites/:siteId/economia/sal-pdf', async (req, res) => {
  const { companyId } = req;
  const { siteId }    = req.params;

  const site = await resolveSite(siteId, companyId);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  // Dati cantiere + azienda
  const [{ data: siteData }, { data: company }, { data: voci }] = await Promise.all([
    supabase.from('sites').select('name, address, client, status').eq('id', siteId).maybeSingle(),
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    supabase.from('site_economia_voci')
      .select('id, tipo, categoria, voce, importo, data_competenza, note')
      .eq('site_id', siteId).eq('company_id', companyId)
      .order('tipo').order('categoria').order('data_competenza', { ascending: false }),
  ]);

  const siteName    = siteData?.name    || 'Cantiere';
  const siteAddress = siteData?.address || '';
  const client      = siteData?.client  || '';
  const companyName = company?.name     || '';
  const budget      = site.budget_totale   !== null ? Number(site.budget_totale)   : null;
  const salPct      = site.sal_percentuale !== null ? Number(site.sal_percentuale) : 0;
  const importoMaturato = budget !== null ? (budget * salPct / 100) : null;

  const costi  = (voci || []).filter(v => v.tipo === 'costo');
  const ricavi = (voci || []).filter(v => v.tipo === 'ricavo');
  const totCosti  = costi.reduce((s, v)  => s + Number(v.importo), 0);
  const totRicavi = ricavi.reduce((s, v) => s + Number(v.importo), 0);
  const utile     = totRicavi - totCosti;

  const now       = new Date();
  const dataEmissione = now.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const safeName  = siteName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);

  function fmtEur(n) {
    return '€ ' + Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function voceRows(list) {
    if (!list.length) return '<tr><td colspan="3" style="padding:12px 16px;color:#6b7280;font-style:italic;font-size:12px">Nessuna voce registrata</td></tr>';
    const grouped = {};
    list.forEach(v => { (grouped[v.categoria] = grouped[v.categoria] || []).push(v); });
    let rows = '';
    for (const [cat, items] of Object.entries(grouped)) {
      rows += `<tr style="background:#f9fafb"><td colspan="2" style="padding:8px 16px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#374151">${cat}</td><td style="padding:8px 16px;text-align:right;font-size:11px;font-weight:700;color:#374151">${fmtEur(items.reduce((s,i)=>s+Number(i.importo),0))}</td></tr>`;
      items.forEach(v => {
        rows += `<tr><td style="padding:7px 16px 7px 28px;font-size:12px;color:#374151;border-bottom:1px solid #f3f4f6">${v.voce}</td><td style="padding:7px 16px;font-size:12px;color:#6b7280;border-bottom:1px solid #f3f4f6">${v.data_competenza ? new Date(v.data_competenza).toLocaleDateString('it-IT') : ''}</td><td style="padding:7px 16px;text-align:right;font-size:12px;color:#374151;border-bottom:1px solid #f3f4f6">${fmtEur(v.importo)}</td></tr>`;
      });
    }
    return rows;
  }

  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color:#111827; background:#fff; }
  .page { padding: 14mm 16mm 10mm; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; padding-bottom:12px; border-bottom:3px solid #111827; margin-bottom:20px; }
  .header-left h1 { font-size:22px; font-weight:800; letter-spacing:-.02em; }
  .header-left p { font-size:12px; color:#6b7280; margin-top:2px; }
  .header-right { text-align:right; }
  .header-right .badge { display:inline-block; background:#111827; color:#fff; font-size:10px; font-weight:700; padding:3px 10px; border-radius:20px; letter-spacing:.06em; text-transform:uppercase; }
  .header-right .date { font-size:11px; color:#6b7280; margin-top:5px; }
  .section { margin-bottom:20px; }
  .section-title { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:#6b7280; margin-bottom:10px; padding-bottom:5px; border-bottom:1px solid #e5e7eb; }
  .info-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .info-item label { font-size:10px; color:#9ca3af; text-transform:uppercase; letter-spacing:.05em; display:block; margin-bottom:2px; }
  .info-item span { font-size:13px; font-weight:600; color:#111827; }
  .kpi-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
  .kpi { background:#f9fafb; border:1px solid #e5e7eb; border-radius:10px; padding:14px 16px; }
  .kpi label { font-size:10px; color:#9ca3af; text-transform:uppercase; letter-spacing:.05em; display:block; margin-bottom:4px; }
  .kpi .val { font-size:18px; font-weight:800; color:#111827; }
  .kpi .sub { font-size:10px; color:#9ca3af; margin-top:2px; }
  .kpi.accent { background:#111827; border-color:#111827; }
  .kpi.accent label, .kpi.accent .sub { color:#9ca3af; }
  .kpi.accent .val { color:#fff; }
  .kpi.green { background:#f0fdf4; border-color:#bbf7d0; }
  .kpi.green .val { color:#15803d; }
  .kpi.red { background:#fef2f2; border-color:#fecaca; }
  .kpi.red .val { color:#dc2626; }
  .progress-bar { background:#e5e7eb; border-radius:99px; height:10px; overflow:hidden; margin:8px 0 4px; }
  .progress-fill { height:100%; border-radius:99px; background:#111827; }
  table { width:100%; border-collapse:collapse; }
  .tbl-head { background:#111827; }
  .tbl-head th { padding:9px 16px; font-size:11px; font-weight:700; color:#fff; text-align:left; }
  .tbl-head th:last-child { text-align:right; }
  .tbl-foot { background:#f9fafb; }
  .tbl-foot td { padding:10px 16px; font-size:12px; font-weight:700; color:#111827; }
  .tbl-foot td:last-child { text-align:right; }
  .signature-grid { display:grid; grid-template-columns:1fr 1fr; gap:30px; margin-top:30px; }
  .sig-box { border-top:2px solid #e5e7eb; padding-top:10px; }
  .sig-box label { font-size:10px; color:#9ca3af; text-transform:uppercase; letter-spacing:.05em; }
  .doc-footer { margin-top:16px; padding:8px 0; font-size:9px; color:#9ca3af; display:flex; justify-content:space-between; border-top:1px solid #e5e7eb; }
  @page { size:A4; margin:0; }
</style></head><body>
<div class="page">

  <div class="header">
    <div class="header-left">
      <h1>${companyName || 'Impresa'}</h1>
      <p>Stato Avanzamento Lavori — ${siteName}</p>
    </div>
    <div class="header-right">
      <div class="badge">SAL</div>
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
    <div class="section-title">Riepilogo SAL</div>
    <div class="kpi-grid">
      <div class="kpi">
        <label>Budget contrattuale</label>
        <div class="val">${budget !== null ? fmtEur(budget) : '—'}</div>
        <div class="sub">valore contratto</div>
      </div>
      <div class="kpi accent">
        <label>Avanzamento lavori</label>
        <div class="val">${salPct.toFixed(1)}%</div>
        <div class="sub">completamento</div>
      </div>
      <div class="kpi ${importoMaturato !== null && importoMaturato >= 0 ? 'green' : ''}">
        <label>Importo maturato</label>
        <div class="val">${importoMaturato !== null ? fmtEur(importoMaturato) : '—'}</div>
        <div class="sub">al ${salPct.toFixed(1)}%</div>
      </div>
      <div class="kpi ${utile >= 0 ? 'green' : 'red'}">
        <label>Risultato economico</label>
        <div class="val">${fmtEur(utile)}</div>
        <div class="sub">${totRicavi > 0 ? `margine ${Math.round((utile/totRicavi)*100)}%` : 'ricavi/costi'}</div>
      </div>
    </div>
    ${budget !== null ? `
    <div style="margin-top:12px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#6b7280;margin-bottom:4px">
        <span>Avanzamento</span><span>${salPct.toFixed(1)}%</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(salPct,100)}%"></div></div>
      <div style="font-size:10px;color:#9ca3af">${fmtEur(importoMaturato)} di ${fmtEur(budget)}</div>
    </div>` : ''}
  </div>

  ${ricavi.length > 0 ? `
  <div class="section">
    <div class="section-title">Ricavi</div>
    <table>
      <thead class="tbl-head"><tr><th>Voce</th><th>Data</th><th style="text-align:right">Importo</th></tr></thead>
      <tbody>${voceRows(ricavi)}</tbody>
      <tfoot class="tbl-foot"><tr><td colspan="2">Totale ricavi</td><td style="text-align:right">${fmtEur(totRicavi)}</td></tr></tfoot>
    </table>
  </div>` : ''}

  ${costi.length > 0 ? `
  <div class="section">
    <div class="section-title">Costi</div>
    <table>
      <thead class="tbl-head"><tr><th>Voce</th><th>Data</th><th style="text-align:right">Importo</th></tr></thead>
      <tbody>${voceRows(costi)}</tbody>
      <tfoot class="tbl-foot"><tr><td colspan="2">Totale costi</td><td style="text-align:right">${fmtEur(totCosti)}</td></tr></tfoot>
    </table>
  </div>` : ''}

  <div class="signature-grid">
    <div class="sig-box">
      <label>Firma Direttore Lavori</label>
      <div style="height:40px"></div>
    </div>
    <div class="sig-box">
      <label>Firma Impresa (${companyName || 'Esecutrice'})</label>
      <div style="height:40px"></div>
    </div>
  </div>

  <div class="doc-footer">
    <span>${siteName} — SAL emesso il ${dataEmissione}</span>
    <span>Generato con Palladia · palladia.it</span>
  </div>
</div>
</body></html>`;

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

module.exports = router;
