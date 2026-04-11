'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function requireSiteOwnership(siteId, companyId, res) {
  const { data } = await supabase.from('sites').select('id')
    .eq('id', siteId).eq('company_id', companyId).maybeSingle();
  if (!data) { res.status(404).json({ error: 'SITE_NOT_FOUND' }); return false; }
  return true;
}

// ── GET /api/v1/sites/:siteId/phases ─────────────────────────────────────────
// Lista fasi con lavoratori assegnati e totale costi.
router.get('/sites/:siteId/phases', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  if (!await requireSiteOwnership(siteId, req.companyId, res)) return;

  const [phasesRes, workersRes, costsRes] = await Promise.all([
    supabase.from('site_phases')
      .select('*')
      .eq('site_id', siteId)
      .order('sort_order').order('created_at'),
    supabase.from('site_phase_workers')
      .select('phase_id, worker_id, workers(id, full_name, qualification)')
      .eq('site_id', siteId),
    supabase.from('site_costs')
      .select('phase_id, importo')
      .eq('site_id', siteId),
  ]);

  const phases  = phasesRes.data  || [];
  const workers = workersRes.data || [];
  const costs   = costsRes.data   || [];

  // Raggruppa lavoratori e somma costi per fase
  const workersByPhase = {};
  for (const w of workers) {
    if (!workersByPhase[w.phase_id]) workersByPhase[w.phase_id] = [];
    if (w.workers) workersByPhase[w.phase_id].push(w.workers);
  }
  const costsByPhase = {};
  for (const c of costs) {
    if (c.phase_id) costsByPhase[c.phase_id] = (costsByPhase[c.phase_id] || 0) + (parseFloat(c.importo) || 0);
  }

  const result = phases.map(p => ({
    ...p,
    workers:     workersByPhase[p.id] || [],
    costi_reali: costsByPhase[p.id]   || 0,
    sforamento:  p.importo_contratto != null &&
                 (costsByPhase[p.id] || 0) > parseFloat(p.importo_contratto),
  }));

  res.json(result);
});

// ── POST /api/v1/sites/:siteId/phases ────────────────────────────────────────
// Crea una nuova fase.
router.post('/sites/:siteId/phases', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  if (!await requireSiteOwnership(siteId, req.companyId, res)) return;

  const { nome, stato, progresso_percentuale, data_inizio_prevista, data_fine_prevista,
          importo_contratto, note, sort_order } = req.body;

  if (!nome?.trim()) return res.status(400).json({ error: 'MISSING_NOME' });

  const { data, error } = await supabase.from('site_phases')
    .insert({
      company_id:              req.companyId,
      site_id:                 siteId,
      nome:                    nome.trim(),
      stato:                   stato || 'non_iniziata',
      progresso_percentuale:   progresso_percentuale ?? 0,
      data_inizio_prevista:    data_inizio_prevista || null,
      data_fine_prevista:      data_fine_prevista   || null,
      importo_contratto:       importo_contratto    || null,
      note:                    note                 || null,
      sort_order:              sort_order           ?? 0,
    })
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ...data, workers: [], costi_reali: 0, sforamento: false });
});

// ── PATCH /api/v1/sites/:siteId/phases/:phaseId ──────────────────────────────
// Aggiorna stato, progresso, date, note.
router.patch('/sites/:siteId/phases/:phaseId', verifySupabaseJwt, async (req, res) => {
  const { siteId, phaseId } = req.params;
  if (!await requireSiteOwnership(siteId, req.companyId, res)) return;
  if (!isUuid(phaseId)) return res.status(400).json({ error: 'INVALID_PHASE_ID' });

  const allowed = ['nome', 'stato', 'progresso_percentuale', 'data_inizio_prevista',
                   'data_fine_prevista', 'data_inizio_reale', 'data_fine_reale',
                   'importo_contratto', 'importo_maturato', 'note', 'sort_order'];
  const updates = {};
  for (const k of allowed) {
    if (k in req.body) updates[k] = req.body[k];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'NO_UPDATES' });

  updates.updated_at = new Date().toISOString();

  // Auto set date_inizio_reale quando si passa a in_corso
  if (updates.stato === 'in_corso' && !updates.data_inizio_reale) {
    updates.data_inizio_reale = new Date().toISOString().slice(0, 10);
  }
  if (updates.stato === 'completata' && !updates.data_fine_reale) {
    updates.data_fine_reale = new Date().toISOString().slice(0, 10);
    if (!updates.progresso_percentuale) updates.progresso_percentuale = 100;
  }

  const { data, error } = await supabase.from('site_phases')
    .update(updates)
    .eq('id', phaseId)
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'PHASE_NOT_FOUND' });
  res.json(data);
});

// ── DELETE /api/v1/sites/:siteId/phases/:phaseId ─────────────────────────────
router.delete('/sites/:siteId/phases/:phaseId', verifySupabaseJwt, async (req, res) => {
  const { siteId, phaseId } = req.params;
  if (!await requireSiteOwnership(siteId, req.companyId, res)) return;
  if (!isUuid(phaseId)) return res.status(400).json({ error: 'INVALID_PHASE_ID' });

  const { error } = await supabase.from('site_phases')
    .delete()
    .eq('id', phaseId).eq('site_id', siteId).eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── POST /api/v1/sites/:siteId/phases/:phaseId/workers ───────────────────────
// Assegna uno o più lavoratori a una fase.
router.post('/sites/:siteId/phases/:phaseId/workers', verifySupabaseJwt, async (req, res) => {
  const { siteId, phaseId } = req.params;
  if (!await requireSiteOwnership(siteId, req.companyId, res)) return;
  if (!isUuid(phaseId)) return res.status(400).json({ error: 'INVALID_PHASE_ID' });

  const workerIds = Array.isArray(req.body.worker_ids) ? req.body.worker_ids : [req.body.worker_id];
  if (!workerIds.length || workerIds.some(id => !isUuid(id)))
    return res.status(400).json({ error: 'INVALID_WORKER_IDS' });

  const rows = workerIds.map(worker_id => ({
    company_id: req.companyId,
    site_id:    siteId,
    phase_id:   phaseId,
    worker_id,
  }));

  const { error } = await supabase.from('site_phase_workers')
    .upsert(rows, { onConflict: 'phase_id,worker_id', ignoreDuplicates: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── DELETE /api/v1/sites/:siteId/phases/:phaseId/workers/:workerId ───────────
router.delete('/sites/:siteId/phases/:phaseId/workers/:workerId', verifySupabaseJwt, async (req, res) => {
  const { phaseId, workerId } = req.params;
  if (!isUuid(phaseId) || !isUuid(workerId)) return res.status(400).json({ error: 'INVALID_ID' });

  const { error } = await supabase.from('site_phase_workers')
    .delete().eq('phase_id', phaseId).eq('worker_id', workerId).eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
