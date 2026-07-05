'use strict';
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

/**
 * GET /api/v1/pos
 * Lista tutti i POS dell'azienda, con info cantiere.
 */
router.get('/pos', verifySupabaseJwt, async (req, res) => {
  const companyId    = req.companyId;
  const filterSiteId = req.query.siteId || null;

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

  const { data: docs, error: docsErr } = await supabase
    .from('pos_documents')
    .select('id, site_id, revision, created_at, created_by, pos_data')
    .in('site_id', siteIds)
    .order('created_at', { ascending: false })
    .limit(200);

  if (docsErr) return res.status(500).json({ error: docsErr.message });

  res.json((docs || []).map(d => ({
    id:         d.id,
    site_id:    d.site_id,
    site_name:  siteMap[d.site_id] ?? '—',
    revision:   d.revision,
    created_at: d.created_at,
    title:      d.pos_data?.workType || d.pos_data?.siteAddress || `Rev. ${d.revision}`,
  })));
});

/**
 * GET /api/v1/pos/draft?siteId=X
 * Bozza POS in costruzione per un cantiere, compilata da Ladia in chat
 * (Fase "POS agentico") — il wizard la usa per precompilarsi al mount invece
 * del vecchio prefill one-shot via sessionStorage.
 * DEVE stare prima di GET /pos/:id altrimenti Express cattura "draft" come :id.
 */
router.get('/pos/draft', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;
  const siteId    = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: 'siteId obbligatorio' });

  const { data, error } = await supabase
    .from('pos_drafts')
    .select('*')
    .eq('site_id', siteId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ draft: data || null });
});

/**
 * GET /api/v1/pos/defaults
 * Figure di sicurezza dall'ultimo POS — per pre-popolare un nuovo form.
 * DEVE stare prima di GET /pos/:id altrimenti Express cattura "defaults" come :id.
 */
router.get('/pos/defaults', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;

  const { data: sites, error: sitesErr } = await supabase
    .from('sites')
    .select('id')
    .eq('company_id', companyId);

  if (sitesErr || !sites?.length) return res.json({ defaults: null });

  const siteIds = sites.map(s => s.id);

  const { data: doc } = await supabase
    .from('pos_documents')
    .select('pos_data')
    .in('site_id', siteIds)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!doc?.pos_data) return res.json({ defaults: null });

  const d = doc.pos_data;
  const persona = (nome = '', tel = '', email = '', cf = '') =>
    ({ nome, telefono: tel, email, codiceFiscale: cf });

  res.json({
    defaults: {
      ragioneSocialeImpresa:  d.companyName || '',
      partitaIvaImpresa:      d.companyVat  || '',
      responsabileLavori:     persona(d.responsabileLavori),
      csp:                    persona(d.csp),
      cse:                    persona(d.cse, d.cseTel, d.cseEmail, d.cseCf),
      rspp:                   persona(d.rspp, d.rsppTel, d.rsppEmail, d.rsppCf),
      rls:                    persona(d.rls, d.rlsTel),
      medicoCompetente:       { ...persona(d.medico, d.medicoTel), firma: '' },
      addettoPrimoSoccorso:   persona(d.primoSoccorso, d.primoSoccorsoTel),
      addettoAntincendio:     persona(d.antincendio, d.antincendioTel),
      direttoreTecnico:       persona(d.direttoreTecnico),
      prepostoCantiere:       persona(d.preposto),
    },
  });
});

/**
 * GET /api/v1/pos/:posId/acknowledgments
 * Lista chi ha firmato e chi no per un POS.
 */
router.get('/pos/:posId/acknowledgments', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;
  const { posId } = req.params;

  const { data: doc, error: docErr } = await supabase
    .from('pos_documents')
    .select('id, site_id')
    .eq('id', posId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (docErr || !doc) return res.status(404).json({ error: 'POS non trovato' });

  const { data: assigned } = await supabase
    .from('worksite_workers')
    .select('worker_id, workers(id, full_name)')
    .eq('site_id', doc.site_id)
    .eq('status', 'active');

  const { data: acks } = await supabase
    .from('pos_acknowledgments')
    .select('worker_id, acknowledged_at')
    .eq('pos_id', posId);

  const ackMap = Object.fromEntries((acks || []).map(a => [a.worker_id, a.acknowledged_at]));

  res.json(
    (assigned || [])
      .map(a => {
        const w = a.workers;
        if (!w) return null;
        return {
          worker_id:   w.id,
          worker_name: w.full_name,
          signed:      !!ackMap[w.id],
          signed_at:   ackMap[w.id] || null,
        };
      })
      .filter(Boolean)
  );
});

/**
 * GET /api/v1/pos/:id
 * Singolo POS (pos_data + content) per la modalità modifica.
 * DEVE stare dopo le route con path specifici (defaults, acknowledgments).
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

module.exports = router;
