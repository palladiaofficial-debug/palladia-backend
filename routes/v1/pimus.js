'use strict';
/**
 * routes/v1/pimus.js — CRUD per pimus_documents
 *
 * GET  /api/v1/pimus                      — lista PIMUS azienda
 * GET  /api/v1/pimus/:id                  — singolo PIMUS
 * GET  /api/v1/sites/:siteId/pimus        — PIMUS per cantiere
 * DELETE /api/v1/pimus/:id                — elimina PIMUS
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

router.get('/pimus', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.query;
  let q = supabase
    .from('pimus_documents')
    .select('id, site_id, revision, created_at, pimus_data')
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (siteId) q = q.eq('site_id', siteId);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json((data || []).map(d => ({
    id:             d.id,
    site_id:        d.site_id,
    revision:       d.revision,
    created_at:     d.created_at,
    ragione_sociale: d.pimus_data?.ragioneSociale || null,
    tipo_ponteggio:  d.pimus_data?.tipoPonteggio  || null,
    altezza_max:     d.pimus_data?.altezzaMax      || null,
  })));
});

router.get('/pimus/:id', verifySupabaseJwt, async (req, res) => {
  const { data, error } = await supabase
    .from('pimus_documents')
    .select('*')
    .eq('id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  if (!data)  return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(data);
});

router.get('/sites/:siteId/pimus', verifySupabaseJwt, async (req, res) => {
  const { data: site } = await supabase
    .from('sites').select('id').eq('id', req.params.siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(404).json({ error: 'NOT_FOUND' });
  const { data, error } = await supabase
    .from('pimus_documents')
    .select('id, site_id, revision, created_at, pimus_data')
    .eq('site_id', req.params.siteId)
    .eq('company_id', req.companyId)
    .order('revision', { ascending: false });
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

router.delete('/pimus/:id', verifySupabaseJwt, async (req, res) => {
  if (!['owner', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  const { error } = await supabase
    .from('pimus_documents')
    .delete()
    .eq('id', req.params.id)
    .eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

module.exports = router;
