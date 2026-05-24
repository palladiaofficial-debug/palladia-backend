'use strict';
// ── Ricerca globale ───────────────────────────────────────────────────────────
// GET /api/v1/search?q=<query>
// Cerca in: cantieri (name, address, client), lavoratori (full_name, fiscal_code),
//           subappaltatori (company_name, fiscal_code)
// Risponde con max 5 risultati per categoria, solo per la company autenticata.
// ─────────────────────────────────────────────────────────────────────────────
const router   = require('express').Router();
const supabase  = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

router.get('/search', verifySupabaseJwt, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) {
    return res.json({ sites: [], workers: [], subcontractors: [] });
  }
  if (q.length > 100) {
    return res.status(400).json({ error: 'query troppo lunga' });
  }

  const companyId = req.companyId;
  const term = `%${q}%`;

  const [sitesRes, workersRes, subsRes] = await Promise.all([
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
  ]);

  res.json({
    sites:         (sitesRes.data   || []).map(s => ({ id: s.id, name: s.name,         address: s.address,       status: s.status,    type: 'site' })),
    workers:       (workersRes.data || []).map(w => ({ id: w.id, name: w.full_name,     sub: w.fiscal_code,       active: w.is_active, type: 'worker' })),
    subcontractors:(subsRes.data    || []).map(s => ({ id: s.id, name: s.company_name,  sub: s.fiscal_code,       status: s.status,    type: 'subcontractor' })),
  });
});

module.exports = router;
