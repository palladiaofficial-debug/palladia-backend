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

/**
 * GET /api/v1/pos/defaults
 * Restituisce le figure di sicurezza dall'ultimo POS creato dall'azienda,
 * per pre-popolare il form di un nuovo POS.
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
  const emptyPersona = (nome = '', tel = '', email = '', cf = '') =>
    ({ nome, telefono: tel, email, codiceFiscale: cf });

  res.json({
    defaults: {
      ragioneSocialeImpresa:   d.companyName  || '',
      partitaIvaImpresa:       d.companyVat   || '',
      responsabileLavori:      emptyPersona(d.responsabileLavori),
      csp:                     emptyPersona(d.csp),
      cse:                     emptyPersona(d.cse, d.cseTel, d.cseEmail, d.cseCf),
      rspp:                    emptyPersona(d.rspp, d.rsppTel, d.rsppEmail, d.rsppCf),
      rls:                     emptyPersona(d.rls, d.rlsTel),
      medicoCompetente:        { ...emptyPersona(d.medico, d.medicoTel), firma: '' },
      addettoPrimoSoccorso:    emptyPersona(d.primoSoccorso, d.primoSoccorsoTel),
      addettoAntincendio:      emptyPersona(d.antincendio, d.antincendioTel),
      direttoreTecnico:        emptyPersona(d.direttoreTecnico),
      prepostoCantiere:        emptyPersona(d.preposto),
    },
  });
});

/**
 * GET /api/v1/pos/:posId/acknowledgments
 * Lista chi ha firmato e chi non ha ancora firmato per un dato POS.
 * Richiede JWT + membership.
 */
router.get('/pos/:posId/acknowledgments', verifySupabaseJwt, async (req, res) => {
  const companyId = req.companyId;
  const { posId } = req.params;

  // Verifica ownership del POS
  const { data: doc, error: docErr } = await supabase
    .from('pos_documents')
    .select('id, site_id')
    .eq('id', posId)
    .maybeSingle();

  if (docErr || !doc) return res.status(404).json({ error: 'POS non trovato' });

  const { data: site } = await supabase
    .from('sites')
    .select('id')
    .eq('id', doc.site_id)
    .eq('company_id', companyId)
    .maybeSingle();

  if (!site) return res.status(403).json({ error: 'Accesso negato' });

  // Lavoratori assegnati al cantiere
  const { data: assigned } = await supabase
    .from('worksite_workers')
    .select('worker_id, workers(id, full_name)')
    .eq('site_id', doc.site_id)
    .eq('status', 'active');

  // Ack già registrate
  const { data: acks } = await supabase
    .from('pos_acknowledgments')
    .select('worker_id, acknowledged_at')
    .eq('pos_id', posId);

  const ackMap = Object.fromEntries((acks || []).map(a => [a.worker_id, a.acknowledged_at]));

  const result = (assigned || []).map(a => {
    const w = a.workers;
    if (!w) return null;
    const acked_at = ackMap[w.id] || null;
    return {
      worker_id:   w.id,
      worker_name: w.full_name,
      signed:      !!acked_at,
      signed_at:   acked_at,
    };
  }).filter(Boolean);

  res.json(result);
});

module.exports = router;
