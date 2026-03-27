'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

/**
 * GET /api/v1/pos
 * Lista tutti i POS dell'azienda, con info cantiere.
 * Richiede JWT + company membership.
 */
router.get('/pos', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;

  // Recupera i cantieri dell'azienda
  const { data: sites, error: sitesErr } = await supabase
    .from('sites')
    .select('id, name')
    .eq('company_id', companyId);

  if (sitesErr) return res.status(500).json({ error: sitesErr.message });

  if (!sites || sites.length === 0) return res.json([]);

  const siteIds = sites.map(s => s.id);
  const siteMap = Object.fromEntries(sites.map(s => [s.id, s.name]));

  // Recupera i POS collegati ai cantieri dell'azienda
  const { data: docs, error: docsErr } = await supabase
    .from('pos_documents')
    .select('id, site_id, revision, created_at, created_by, pos_data')
    .in('site_id', siteIds)
    .order('created_at', { ascending: false })
    .limit(200);

  if (docsErr) return res.status(500).json({ error: docsErr.message });

  const result = (docs || []).map(d => ({
    id:         d.id,
    site_id:    d.site_id,
    site_name:  siteMap[d.site_id] ?? '—',
    revision:   d.revision,
    created_at: d.created_at,
    title:      d.pos_data?.workType || d.pos_data?.siteAddress || `Rev. ${d.revision}`,
  }));

  res.json(result);
});

module.exports = router;
