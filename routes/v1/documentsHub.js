'use strict';
/**
 * routes/v1/documentsHub.js
 * Hub documenti unificato — aggrega site_documents, company_documents, worker_documents.
 *
 * GET /api/v1/documents/search?q=&scope=all|site|company|workers&siteId=&workerId=&category=
 * GET /api/v1/documents/expiring?days=60&scope=all|company|workers&includeExpired=true
 * GET /api/v1/sites/:siteId/documents/summary
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

router.use(verifySupabaseJwt);

function today() {
  return new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
}
function futureDate(days) {
  return new Date(Date.now() + Number(days) * 86400000)
    .toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
}

// ── GET /api/v1/documents/search ─────────────────────────────────────────────
router.get('/documents/search', async (req, res) => {
  const { q = '', scope = 'all', siteId, workerId, category } = req.query;
  const companyId = req.companyId;
  const ilike     = q ? `%${q}%` : '%';
  const ql        = q.toLowerCase();
  const ora       = today();
  const presto    = futureDate(30);
  const results   = [];

  try {
    // Pre-fetch site names (evita join FK fragili)
    const { data: sitesData } = await supabase
      .from('sites').select('id, name').eq('company_id', companyId).limit(200);
    const siteMap    = Object.fromEntries((sitesData || []).map(s => [s.id, s.name]));
    const allSiteIds = Object.keys(siteMap);
    const inSites    = siteId ? [siteId] : allSiteIds;

    await Promise.all([
      // 1. Documenti cantiere
      (scope === 'all' || scope === 'site') && (async () => {
        let query = supabase
          .from('site_documents')
          .select('id, name, category, file_size, mime_type, created_at, site_id')
          .eq('company_id', companyId)
          .ilike('name', ilike)
          .order('created_at', { ascending: false })
          .limit(50);
        if (siteId)   query = query.eq('site_id', siteId);
        if (category) query = query.eq('category', category);
        const { data } = await query;
        (data || []).forEach(d => results.push({
          fonte:             'cantiere',
          id:                d.id,
          nome:              d.name,
          tipo:              d.category,
          cantiere:          siteMap[d.site_id] || null,
          site_id:           d.site_id,
          data_caricamento:  d.created_at?.slice(0, 10),
          file_size:         d.file_size,
          mime_type:         d.mime_type,
          download_endpoint: `/api/v1/documents/${d.id}/download`,
        }));
      })(),

      // 2. POS generati da AI
      (scope === 'all' || scope === 'site') && allSiteIds.length > 0 && (!category || category === 'pos') && (async () => {
        const { data: posDocs } = await supabase
          .from('pos_documents')
          .select('id, site_id, revision, created_at')
          .in('site_id', inSites)
          .order('created_at', { ascending: false })
          .limit(30);
        (posDocs || []).forEach(d => {
          const nome = `POS — Revisione ${d.revision}`;
          if (ql && !nome.toLowerCase().includes(ql) && !ql.includes('pos')) return;
          results.push({
            fonte:             'cantiere',
            id:                `pos_${d.id}`,
            nome,
            tipo:              'pos',
            cantiere:          siteMap[d.site_id] || null,
            site_id:           d.site_id,
            data_caricamento:  d.created_at?.slice(0, 10),
            mime_type:         'application/pdf',
            pos_id:            d.id,
            download_endpoint: null,
            nota:              'PDF Palladia — scaricabile dalla pagina cantiere',
          });
        });
      })(),

      // 3. Documenti aziendali
      (scope === 'all' || scope === 'company') && (async () => {
        let query = supabase
          .from('company_documents')
          .select('id, name, category, file_size, mime_type, created_at, ai_expiry_date, ai_validity_ok, ai_summary')
          .eq('company_id', companyId)
          .ilike('name', ilike)
          .order('created_at', { ascending: false })
          .limit(50);
        if (category) query = query.eq('category', category);
        const { data } = await query;
        (data || []).forEach(d => results.push({
          fonte:             'azienda',
          id:                d.id,
          nome:              d.name,
          tipo:              d.category,
          scadenza:          d.ai_expiry_date || null,
          valido:            d.ai_validity_ok,
          sommario_ai:       d.ai_summary || null,
          data_caricamento:  d.created_at?.slice(0, 10),
          file_size:         d.file_size,
          mime_type:         d.mime_type,
          download_endpoint: `/api/v1/company-documents/${d.id}/download`,
        }));
      })(),

      // 4. Documenti lavoratori
      (scope === 'all' || scope === 'workers') && (async () => {
        let query = supabase
          .from('worker_documents')
          .select('id, name, doc_type, expiry_date, ai_expiry_date, ai_validity_ok, ai_summary, created_at, mime_type, worker_id, workers(full_name)')
          .eq('company_id', companyId)
          .ilike('name', ilike)
          .order('expiry_date', { ascending: true, nullsFirst: false })
          .limit(100);
        if (workerId) query = query.eq('worker_id', workerId);
        if (category) query = query.eq('doc_type', category);
        const { data } = await query;
        (data || []).forEach(d => {
          const scad   = d.expiry_date || d.ai_expiry_date;
          const status = !scad ? 'nessuna_scadenza'
            : scad < ora ? 'scaduto' : scad < presto ? 'in_scadenza' : 'valido';
          results.push({
            fonte:             'lavoratore',
            id:                d.id,
            nome:              d.name,
            tipo:              d.doc_type,
            lavoratore:        d.workers?.full_name || null,
            worker_id:         d.worker_id,
            scadenza:          scad || null,
            status_scadenza:   status,
            sommario_ai:       d.ai_summary || null,
            data_caricamento:  d.created_at?.slice(0, 10),
            mime_type:         d.mime_type,
            download_endpoint: `/api/v1/workers/${d.worker_id}/documents/${d.id}/download`,
          });
        });
      })(),

      // 5. Attestati formazione (worker_certificates)
      (scope === 'all' || scope === 'workers') && (!category || category === 'attestato_formazione') && (async () => {
        let query = supabase
          .from('worker_certificates')
          .select('id, worker_id, expiry_date, issue_date, pdf_url, issuing_body, course_types(name), workers(full_name)')
          .eq('company_id', companyId)
          .order('expiry_date', { ascending: true, nullsFirst: false })
          .limit(200);
        if (workerId) query = query.eq('worker_id', workerId);
        const { data, error } = await query;
        if (error?.code === '42P01') return; // tabella non ancora migrata — skip
        (data || []).forEach(d => {
          const nome = d.course_types?.name || 'Attestato formazione';
          if (ql && !nome.toLowerCase().includes(ql) && !(d.issuing_body || '').toLowerCase().includes(ql)) return;
          const scad   = d.expiry_date;
          const status = !scad ? 'nessuna_scadenza'
            : scad < ora ? 'scaduto' : scad < presto ? 'in_scadenza' : 'valido';
          results.push({
            fonte:             'lavoratore',
            id:                d.id,
            nome,
            tipo:              'attestato_formazione',
            lavoratore:        d.workers?.full_name || null,
            worker_id:         d.worker_id,
            ente_emittente:    d.issuing_body || null,
            scadenza:          scad || null,
            status_scadenza:   status,
            data_emissione:    d.issue_date || null,
            mime_type:         d.pdf_url ? 'application/pdf' : null,
            file_size:         null,
            download_endpoint: d.pdf_url || null,
          });
        });
      })(),
    ].filter(Boolean));

    results.sort((a, b) => (b.data_caricamento || '').localeCompare(a.data_caricamento || ''));
    res.json({ results, total: results.length });
  } catch (err) {
    console.error('[documentsHub] search error:', err.message);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// ── GET /api/v1/documents/expiring ────────────────────────────────────────────
router.get('/documents/expiring', async (req, res) => {
  const days           = Math.min(Number(req.query.days) || 60, 365);
  const includeExpired = req.query.includeExpired !== 'false';
  const scope          = req.query.scope || 'all';
  const companyId      = req.companyId;
  const ora            = today();
  const limite         = futureDate(days);
  const results        = [];

  try {
    await Promise.all([
      // Documenti aziendali con scadenza AI
      (scope === 'all' || scope === 'company') && (async () => {
        const { data } = await supabase
          .from('company_documents')
          .select('id, name, category, ai_expiry_date, ai_validity_ok')
          .eq('company_id', companyId)
          .not('ai_expiry_date', 'is', null)
          .lte('ai_expiry_date', limite)
          .order('ai_expiry_date');
        (data || []).forEach(d => {
          if (!includeExpired && d.ai_expiry_date < ora) return;
          const giorni = Math.ceil((new Date(d.ai_expiry_date) - new Date(ora)) / 86400000);
          results.push({
            fonte:              'azienda',
            id:                 d.id,
            nome:               d.name,
            tipo:               d.category,
            scadenza:           d.ai_expiry_date,
            status:             d.ai_expiry_date < ora ? 'scaduto' : 'in_scadenza',
            giorni_mancanti:    giorni,
            download_endpoint:  `/api/v1/company-documents/${d.id}/download`,
          });
        });
      })(),

      // Documenti lavoratori (worker_documents)
      (scope === 'all' || scope === 'workers') && (async () => {
        const { data } = await supabase
          .from('worker_documents')
          .select('id, name, doc_type, expiry_date, ai_expiry_date, worker_id, workers(full_name)')
          .eq('company_id', companyId)
          .or(`expiry_date.lte.${limite},and(expiry_date.is.null,ai_expiry_date.lte.${limite})`)
          .order('expiry_date', { ascending: true, nullsFirst: false });
        (data || []).forEach(d => {
          const scad = d.expiry_date || d.ai_expiry_date;
          if (!scad) return;
          if (!includeExpired && scad < ora) return;
          const giorni = Math.ceil((new Date(scad) - new Date(ora)) / 86400000);
          results.push({
            fonte:             'lavoratore',
            id:                d.id,
            nome:              d.name,
            tipo:              d.doc_type,
            lavoratore:        d.workers?.full_name || null,
            worker_id:         d.worker_id,
            scadenza:          scad,
            status:            scad < ora ? 'scaduto' : 'in_scadenza',
            giorni_mancanti:   giorni,
            download_endpoint: `/api/v1/workers/${d.worker_id}/documents/${d.id}/download`,
          });
        });
      })(),

      // Attestati formazione (worker_certificates)
      (scope === 'all' || scope === 'workers') && (async () => {
        const { data, error } = await supabase
          .from('worker_certificates')
          .select('id, worker_id, expiry_date, pdf_url, course_types(name), workers(full_name)')
          .eq('company_id', companyId)
          .not('expiry_date', 'is', null)
          .lte('expiry_date', limite)
          .order('expiry_date', { ascending: true });
        if (error?.code === '42P01') return; // tabella non ancora migrata
        (data || []).forEach(d => {
          if (!includeExpired && d.expiry_date < ora) return;
          const giorni = Math.ceil((new Date(d.expiry_date) - new Date(ora)) / 86400000);
          results.push({
            fonte:             'lavoratore',
            id:                d.id,
            nome:              d.course_types?.name || 'Attestato formazione',
            tipo:              'attestato_formazione',
            lavoratore:        d.workers?.full_name || null,
            worker_id:         d.worker_id,
            scadenza:          d.expiry_date,
            status:            d.expiry_date < ora ? 'scaduto' : 'in_scadenza',
            giorni_mancanti:   giorni,
            download_endpoint: d.pdf_url || null,
          });
        });
      })(),
    ].filter(Boolean));

    results.sort((a, b) => a.giorni_mancanti - b.giorni_mancanti);

    const scaduti    = results.filter(r => r.status === 'scaduto');
    const inScadenza = results.filter(r => r.status === 'in_scadenza');
    res.json({ scaduti, in_scadenza: inScadenza, total: results.length, days_horizon: days });
  } catch (err) {
    console.error('[documentsHub] expiring error:', err.message);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

// ── GET /api/v1/sites/:siteId/documents/summary ───────────────────────────────
router.get('/sites/:siteId/documents/summary', async (req, res) => {
  const { siteId }  = req.params;
  const companyId   = req.companyId;
  const ora         = today();
  const presto      = futureDate(30);

  const { data: site } = await supabase
    .from('sites').select('id, name').eq('id', siteId).eq('company_id', companyId).maybeSingle();
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  try {
    const [
      { data: siteDocs },
      { data: posDocs },
      { data: siteWorkers },
    ] = await Promise.all([
      supabase.from('site_documents')
        .select('id, name, category, created_at, file_size, mime_type')
        .eq('site_id', siteId).eq('company_id', companyId)
        .order('created_at', { ascending: false }),
      supabase.from('pos_documents')
        .select('id, revision, created_at')
        .eq('site_id', siteId)
        .order('created_at', { ascending: false }).limit(10),
      supabase.from('worksite_workers')
        .select('worker_id, workers(id, full_name, health_fitness_expiry, safety_training_expiry, is_active)')
        .eq('site_id', siteId).eq('company_id', companyId).eq('status', 'active'),
    ]);

    // Raggruppa per categoria
    const byCategory = {};
    (siteDocs || []).forEach(d => {
      if (!byCategory[d.category]) byCategory[d.category] = [];
      byCategory[d.category].push({
        id:        d.id,
        nome:      d.name,
        data:      d.created_at?.slice(0, 10),
        file_size: d.file_size,
        mime_type: d.mime_type,
        download:  `/api/v1/documents/${d.id}/download`,
      });
    });

    // Checklist documenti tipici
    const categoriePresenti = new Set(Object.keys(byCategory));
    const checklist = [
      { tipo: 'pos',           label: 'POS',           presente: (posDocs || []).length > 0 },
      { tipo: 'dvr',           label: 'DVR',           presente: categoriePresenti.has('dvr')  },
      { tipo: 'psc',           label: 'PSC',           presente: categoriePresenti.has('psc')  },
      { tipo: 'notifica_asl',  label: 'Notifica ASL',  presente: categoriePresenti.has('notifica_asl') },
      { tipo: 'durc',          label: 'DURC',          presente: categoriePresenti.has('durc') },
      { tipo: 'assicurazione', label: 'Assicurazione', presente: categoriePresenti.has('assicurazione') },
    ];

    // Compliance lavoratori
    const lavoratori = (siteWorkers || []).map(sw => {
      const w = sw.workers;
      if (!w) return null;
      const issues = [];
      const idScad  = w.health_fitness_expiry;
      const forScad = w.safety_training_expiry;

      if (!idScad)             issues.push({ tipo: 'idoneita_medica',      label: 'Idoneità medica',      status: 'mancante' });
      else if (idScad < ora)   issues.push({ tipo: 'idoneita_medica',      label: 'Idoneità medica',      status: 'scaduta',    scadenza: idScad });
      else if (idScad < presto)issues.push({ tipo: 'idoneita_medica',      label: 'Idoneità medica',      status: 'in_scadenza', scadenza: idScad });

      if (!forScad)              issues.push({ tipo: 'formazione_sicurezza', label: 'Formazione sicurezza', status: 'mancante' });
      else if (forScad < ora)    issues.push({ tipo: 'formazione_sicurezza', label: 'Formazione sicurezza', status: 'scaduta',    scadenza: forScad });
      else if (forScad < presto) issues.push({ tipo: 'formazione_sicurezza', label: 'Formazione sicurezza', status: 'in_scadenza', scadenza: forScad });

      return {
        id:           w.id,
        nome:         w.full_name,
        compliance:   issues.length === 0 ? 'ok' : issues.some(i => i.status === 'scaduta' || i.status === 'mancante') ? 'ko' : 'warning',
        issues,
      };
    }).filter(Boolean);

    const ok      = lavoratori.filter(l => l.compliance === 'ok').length;
    const warning = lavoratori.filter(l => l.compliance === 'warning').length;
    const ko      = lavoratori.filter(l => l.compliance === 'ko').length;
    const total   = lavoratori.length;

    res.json({
      site_id:   siteId,
      cantiere:  site.name,
      documenti: {
        totale:         (siteDocs || []).length,
        pos_presenti:   (posDocs || []).length,
        pos:            (posDocs || []).map(p => ({ id: p.id, revisione: p.revision, data: p.created_at?.slice(0,10) })),
        per_categoria:  byCategory,
        checklist,
        mancanti:       checklist.filter(c => !c.presente).map(c => c.label),
      },
      compliance_lavoratori: {
        totale: total,
        ok,
        warning,
        ko,
        score_pct: total > 0 ? Math.round(ok / total * 100) : null,
        lavoratori,
      },
    });
  } catch (err) {
    console.error('[documentsHub] summary error:', err.message);
    res.status(500).json({ error: 'INTERNAL' });
  }
});

module.exports = router;
