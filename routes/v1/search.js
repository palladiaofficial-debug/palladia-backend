'use strict';
// ── Ricerca globale ───────────────────────────────────────────────────────────
// GET /api/v1/search?q=<query>
// Cerca in: cantieri (name, address, client), lavoratori (full_name, fiscal_code),
//           subappaltatori (company_name, fiscal_code), mezzi (type, model,
//           plate_or_serial), documenti (name, nella vista unificata `documents`).
// Risponde con max 5 risultati per categoria, solo per la company autenticata.
//
// F-065 (AUDIT.md, 2026-08-22): mezzi e documenti non erano cercabili — un
// titolare che non ricorda dove vive un documento (Risorse? Documenti?
// Cantiere?) non aveva modo di trovarlo per nome.
// ─────────────────────────────────────────────────────────────────────────────
const router   = require('express').Router();
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

const EMPTY_RESULTS = { sites: [], workers: [], subcontractors: [], equipment: [], documents: [] };

router.get('/search', verifySupabaseJwt, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) {
    return res.json(EMPTY_RESULTS);
  }
  if (q.length > 100) {
    return res.status(400).json({ error: 'query troppo lunga' });
  }

  const companyId = req.companyId;
  const term = `%${q}%`;

  const [sitesRes, workersRes, subsRes, equipmentRes, documentsRes] = await Promise.all([
    supabase
      .from('sites')
      .select('id, name, address, client, status')
      .eq('company_id', companyId)
      .neq('status', 'eliminato')
      .or(`name.ilike.${term},address.ilike.${term},client.ilike.${term}`)
      .order('name')
      .limit(5),

    supabase
      .from('workers')
      .select('id, full_name, fiscal_code, is_active')
      .eq('company_id', companyId)
      .or(`full_name.ilike.${term},fiscal_code.ilike.${term}`)
      .order('full_name')
      .limit(5),

    supabase
      .from('subcontractors')
      .select('id, company_name, fiscal_code, status')
      .eq('company_id', companyId)
      .or(`company_name.ilike.${term},fiscal_code.ilike.${term}`)
      .order('company_name')
      .limit(5),

    supabase
      .from('equipment')
      .select('id, name, type, model, plate_or_serial, is_active')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .or(`name.ilike.${term},type.ilike.${term},model.ilike.${term},plate_or_serial.ilike.${term}`)
      .order('name')
      .limit(5),

    supabase
      .from('documents')
      .select('id, name, category')
      .eq('company_id', companyId)
      .not('name', 'is', null)
      .ilike('name', term)
      .order('name')
      .limit(5),
  ]);

  res.json({
    sites:         (sitesRes.data      || []).map(s => ({ id: s.id, name: s.name,     address: s.address,      status: s.status,    type: 'site' })),
    workers:       (workersRes.data    || []).map(w => ({ id: w.id, name: w.full_name,                             sub: w.fiscal_code, active: w.is_active, type: 'worker' })),
    subcontractors:(subsRes.data       || []).map(s => ({ id: s.id, name: s.company_name,                          sub: s.fiscal_code, status: s.status,    type: 'subcontractor' })),
    equipment:     (equipmentRes.data  || []).map(e => ({ id: e.id, name: e.name || `${e.type} ${e.model || ''}`.trim(), sub: e.plate_or_serial || e.type,   type: 'equipment' })),
    documents:     (documentsRes.data  || []).map(d => ({ id: d.id, name: d.name,                                  sub: d.category,    type: 'document' })),
  });
});

module.exports = router;
