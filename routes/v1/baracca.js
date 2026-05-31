'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const router    = require('express').Router();
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { renderHtmlToPdf }   = require('../../pdf-renderer');
const { complianceStatus, overallStatus } = require('../../lib/compliance');

let _anthropic = null;
function getClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// complianceStatus e overallStatus importati da lib/compliance.js

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('it-IT');
}

const STATIC_ITEMS = [
  { key: 'pos',               label: 'Piano Operativo di Sicurezza (POS)' },
  { key: 'notifica_prel',     label: 'Notifica Preliminare' },
  { key: 'dvr',               label: 'DVR dell\'impresa' },
  { key: 'registro_infortuni',label: 'Registro Infortuni aggiornato' },
  { key: 'duvri',             label: 'DUVRI (se presenti subappaltatori)' },
  { key: 'piano_emergenza',   label: 'Piano di Emergenza ed Evacuazione' },
  { key: 'primo_soccorso',    label: 'Cassetta di Primo Soccorso verificata' },
  { key: 'dpi_verbale',       label: 'Verbali consegna DPI lavoratori' },
];

async function getSiteData(siteId, companyId) {
  const { data: site, error: siteErr } = await supabase
    .from('sites')
    .select('id, name, address, client, start_date, end_date, status')
    .eq('id', siteId)
    .eq('company_id', companyId)
    .single();
  if (siteErr || !site) return null;

  const { data: siteWorkers } = await supabase
    .from('worksite_workers')
    .select('worker:workers(id, full_name, fiscal_code, safety_training_expiry, health_fitness_expiry, qualification, role)')
    .eq('site_id', siteId)
    .eq('status', 'active');

  const workers = (siteWorkers || []).map(sw => sw.worker).filter(Boolean);

  const { data: checklist } = await supabase
    .from('site_baracca_checklist')
    .select('item_key, checked, checked_at')
    .eq('site_id', siteId)
    .eq('company_id', companyId);

  const checkMap = {};
  for (const item of checklist || []) checkMap[item.item_key] = item;

  const workersWithStatus = workers.map(w => ({
    id: w.id,
    full_name: w.full_name,
    fiscal_code: w.fiscal_code,
    qualification: w.qualification || null,
    role: w.role || null,
    safety_training_expiry: w.safety_training_expiry || null,
    health_fitness_expiry:  w.health_fitness_expiry  || null,
    safety_training_status: complianceStatus(w.safety_training_expiry),
    health_fitness_status:  complianceStatus(w.health_fitness_expiry),
    overall_status:         overallStatus(w),
    checklist: {
      idoneita:   checkMap[`worker_${w.id}_idoneita`]   || { checked: false },
      formazione: checkMap[`worker_${w.id}_formazione`] || { checked: false },
    },
  }));

  const siteChecklist = STATIC_ITEMS.map(item => ({
    ...item,
    ...(checkMap[item.key] || { checked: false, checked_at: null }),
  }));

  return { site, workers: workersWithStatus, siteChecklist };
}

// ── GET /api/v1/sites/:siteId/baracca ─────────────────────────────────────────
router.get('/sites/:siteId/baracca', verifySupabaseJwt, async (req, res) => {
  const data = await getSiteData(req.params.siteId, req.companyId);
  if (!data) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
  res.json(data);
});

// ── PATCH /api/v1/sites/:siteId/baracca/checklist ────────────────────────────
router.patch('/sites/:siteId/baracca/checklist', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { item_key, checked } = req.body;
  if (!item_key) return res.status(400).json({ error: 'item_key required' });

  const { data: site } = await supabase
    .from('sites')
    .select('id')
    .eq('id', siteId)
    .eq('company_id', req.companyId)
    .single();
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { error } = await supabase
    .from('site_baracca_checklist')
    .upsert({
      company_id: req.companyId,
      site_id: siteId,
      item_key,
      checked: !!checked,
      checked_at: checked ? new Date().toISOString() : null,
      checked_by: req.user?.id || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'site_id,item_key' });

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.json({ ok: true });
});

// ── POST /api/v1/sites/:siteId/baracca/ai ────────────────────────────────────
router.post('/sites/:siteId/baracca/ai', verifySupabaseJwt, async (req, res) => {
  const data = await getSiteData(req.params.siteId, req.companyId);
  if (!data) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { site, workers } = data;
  const nonCompliant = workers.filter(w => w.overall_status !== 'compliant');

  const prompt = `Sei un esperto di sicurezza sul lavoro (D.Lgs. 81/08). Analizza questo cantiere e fornisci una lista concisa di checklist aggiuntive da tenere nella baracca.

Cantiere: ${site.name}
Indirizzo: ${site.address}
Committente: ${site.client || 'non specificato'}
Lavoratori assegnati: ${workers.length}
Lavoratori con documenti incompleti/scaduti: ${nonCompliant.length}

Fornisci SOLO un array JSON con massimo 6 voci aggiuntive, nel formato:
[{"label": "...", "reason": "..."}]

Considera: tipo di lavori, presenza di subappaltatori, lavori in quota, scavi, ecc. Sii conciso.`;

  try {
    const msg = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content[0]?.text || '[]';
    const match = text.match(/\[[\s\S]*\]/);
    const suggestions = match ? JSON.parse(match[0]) : [];
    res.json({ suggestions });
  } catch (e) {
    res.status(500).json({ error: 'AI_ERROR', detail: e.message });
  }
});

// ── GET /api/v1/sites/:siteId/baracca/pdf ────────────────────────────────────
router.get('/sites/:siteId/baracca/pdf', verifySupabaseJwt, async (req, res) => {
  const data = await getSiteData(req.params.siteId, req.companyId);
  if (!data) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const { site, workers, siteChecklist } = data;
  const printDate = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });

  const statusLabel = { compliant: 'Conforme', expiring: 'In scadenza', non_compliant: 'Non conforme', incomplete: 'Dati incompleti' };
  const statusColor = { compliant: '#16a34a', expiring: '#d97706', non_compliant: '#dc2626', incomplete: '#6b7280' };
  const docStatus = { ok: '✓', expiring: '⚠', expired: '✗', not_set: '—' };
  const docColor  = { ok: '#16a34a', expiring: '#d97706', expired: '#dc2626', not_set: '#9ca3af' };

  const workersRows = workers.map(w => `
    <tr>
      <td>${w.full_name}</td>
      <td style="color:${docColor[w.safety_training_status]}">${docStatus[w.safety_training_status]} ${w.safety_training_expiry ? fmtDate(w.safety_training_expiry) : '—'}</td>
      <td style="color:${docColor[w.health_fitness_status]}">${docStatus[w.health_fitness_status]} ${w.health_fitness_expiry ? fmtDate(w.health_fitness_expiry) : '—'}</td>
      <td style="color:${statusColor[w.overall_status] || '#6b7280'};font-weight:600">${statusLabel[w.overall_status] || w.overall_status}</td>
    </tr>`).join('');

  const checklistRows = siteChecklist.map(item => `
    <tr>
      <td><span style="display:inline-block;width:16px;height:16px;border:2px solid ${item.checked ? '#16a34a' : '#d1d5db'};border-radius:3px;background:${item.checked ? '#16a34a' : 'white'};color:white;text-align:center;line-height:14px;font-size:11px">${item.checked ? '✓' : ''}</span></td>
      <td>${item.label}</td>
      <td style="color:#6b7280;font-size:11px">${item.checked && item.checked_at ? fmtDate(item.checked_at) : '—'}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 12px; color: #111; padding: 20mm 16mm; }
  h1 { font-size: 22px; font-weight: 800; margin-bottom: 4px; }
  h2 { font-size: 14px; font-weight: 700; margin: 20px 0 8px; border-bottom: 2px solid #e5e7eb; padding-bottom: 4px; }
  .meta { font-size: 11px; color: #6b7280; margin-bottom: 20px; }
  .meta span { margin-right: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
  td { padding: 7px 8px; border-bottom: 1px solid #f3f4f6; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  .footer { margin-top: 24px; font-size: 10px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 8px; display: flex; justify-content: space-between; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 600; }
  .stats { display: flex; gap: 16px; margin-bottom: 16px; }
  .stat-box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; flex: 1; }
  .stat-num { font-size: 24px; font-weight: 800; }
  .stat-lbl { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px; }
</style>
</head>
<body>
  <h1>Kit Baracca di Cantiere</h1>
  <div class="meta">
    <span><strong>${site.name}</strong></span>
    <span>${site.address}</span>
    ${site.client ? `<span>Committente: ${site.client}</span>` : ''}
    <span>Stampato il ${printDate}</span>
  </div>

  <div class="stats">
    <div class="stat-box">
      <div class="stat-num">${workers.length}</div>
      <div class="stat-lbl">Lavoratori assegnati</div>
    </div>
    <div class="stat-box">
      <div class="stat-num" style="color:#16a34a">${workers.filter(w => w.overall_status === 'compliant').length}</div>
      <div class="stat-lbl">Conformi</div>
    </div>
    <div class="stat-box">
      <div class="stat-num" style="color:#d97706">${workers.filter(w => w.overall_status === 'expiring').length}</div>
      <div class="stat-lbl">In scadenza</div>
    </div>
    <div class="stat-box">
      <div class="stat-num" style="color:#dc2626">${workers.filter(w => w.overall_status === 'non_compliant' || w.overall_status === 'incomplete').length}</div>
      <div class="stat-lbl">Da completare</div>
    </div>
  </div>

  <h2>Registro Lavoratori</h2>
  <table>
    <thead>
      <tr>
        <th>Lavoratore</th>
        <th>Formazione Sicurezza</th>
        <th>Idoneità Medica</th>
        <th>Stato</th>
      </tr>
    </thead>
    <tbody>${workersRows || '<tr><td colspan="4" style="color:#9ca3af;text-align:center;padding:16px">Nessun lavoratore assegnato</td></tr>'}</tbody>
  </table>

  <h2>Checklist Documenti Baracca</h2>
  <table>
    <thead>
      <tr>
        <th style="width:30px"></th>
        <th>Documento</th>
        <th style="width:100px">Verificato il</th>
      </tr>
    </thead>
    <tbody>${checklistRows}</tbody>
  </table>

  <div class="footer">
    <span>Generato da Palladia · ${site.name}</span>
    <span>${printDate}</span>
  </div>
</body>
</html>`;

  try {
    const pdfBuf = await renderHtmlToPdf(html, { noHeaderFooter: true });
    const safeName = site.name.replace(/[^a-zA-Z0-9\-_]/g, '_').slice(0, 40);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="kit-baracca-${safeName}.pdf"`);
    res.send(pdfBuf);
  } catch (e) {
    console.error('[baracca/pdf]', e.message);
    res.status(500).json({ error: 'PDF_ERROR', detail: e.message });
  }
});

module.exports = router;
