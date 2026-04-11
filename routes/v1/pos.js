'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

/**
 * GET /api/v1/pos/:id
 * Restituisce un singolo POS (pos_data + content) per la modalità modifica.
 */
router.get('/pos/:id', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;
  const { id } = req.params;

  const { data: doc, error } = await supabase
    .from('pos_documents')
    .select('id, site_id, revision, created_at, pos_data, content')
    .eq('id', id)
    .single();

  if (error || !doc) return res.status(404).json({ error: 'POS non trovato' });

  // Verifica ownership: se site_id presente, controlla che appartenga all'azienda
  if (doc.site_id) {
    const { data: site } = await supabase
      .from('sites')
      .select('id')
      .eq('id', doc.site_id)
      .eq('company_id', companyId)
      .single();
    if (!site) return res.status(403).json({ error: 'Accesso negato' });
  }

  res.json({
    id:         doc.id,
    site_id:    doc.site_id,
    revision:   doc.revision,
    created_at: doc.created_at,
    pos_data:   doc.pos_data,
    content:    doc.content,
  });
});

/**
 * GET /api/v1/pos
 * Lista tutti i POS dell'azienda, con info cantiere.
 * Richiede JWT + company membership.
 */
router.get('/pos', verifySupabaseJwt, async (req, res) => {
  const companyId     = req.companyId;
  const filterSiteId  = req.query.siteId || null;

  // Recupera i cantieri dell'azienda
  const { data: sites, error: sitesErr } = await supabase
    .from('sites')
    .select('id, name')
    .eq('company_id', companyId);

  if (sitesErr) return res.status(500).json({ error: sitesErr.message });

  if (!sites || sites.length === 0) return res.json([]);

  const siteIds = filterSiteId
    ? sites.filter(s => s.id === filterSiteId).map(s => s.id)
    : sites.map(s => s.id);

  if (!siteIds.length) return res.json([]);

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
