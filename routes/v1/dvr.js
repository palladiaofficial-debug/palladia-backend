'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// ── GET /api/v1/dvr — lista DVR dell'azienda ──────────────────────────────────
router.get('/dvr', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.query;
  let query = supabase
    .from('dvr_documents')
    .select('id, site_id, revision, created_at, updated_at, dvr_data')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (siteId) query = query.eq('site_id', siteId);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });

  res.json((data || []).map(d => ({
    id:          d.id,
    site_id:     d.site_id,
    revision:    d.revision,
    created_at:  d.created_at,
    updated_at:  d.updated_at,
    ragione_sociale: d.dvr_data?.ragioneSociale || null,
    datore_lavoro:   d.dvr_data?.datoreLavoro   || null,
  })));
});

// ── GET /api/v1/dvr/:id — singolo DVR ─────────────────────────────────────────
router.get('/dvr/:id', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('dvr_documents')
    .select('*')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data)  return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(data);
});

// ── GET /api/v1/sites/:siteId/dvr — DVR per cantiere ─────────────────────────
router.get('/sites/:siteId/dvr', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  const { data: site } = await supabase
    .from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data, error } = await supabase
    .from('dvr_documents')
    .select('id, site_id, revision, created_at, dvr_data')
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .order('revision', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json((data || []).map(d => ({
    id:         d.id,
    revision:   d.revision,
    created_at: d.created_at,
    ragione_sociale: d.dvr_data?.ragioneSociale || null,
  })));
});

// ── DELETE /api/v1/dvr/:id — elimina DVR ──────────────────────────────────────
router.delete('/dvr/:id', verifySupabaseJwt, async (req, res) => {
  const { data: existing } = await supabase
    .from('dvr_documents').select('id')
    .eq('id', req.params.id).eq('company_id', req.companyId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const { error } = await supabase
    .from('dvr_documents').delete()
    .eq('id', req.params.id).eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

module.exports = router;
