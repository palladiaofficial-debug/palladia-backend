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
      .select('id, name, category, owner_type, site_id, worker_id, subcontractor_id, equipment_id')
      .eq('company_id', companyId)
      .is('deleted_at', null)
      .not('name', 'is', null)
      .ilike('name', term)
      .order('name')
      .limit(5),
  ]);

  // F-130 (AUDIT.md): prima la ricerca apriva sempre l'hub generico
  // /documenti, mai il documento trovato — perché quella pagina non aveva
  // una URL per la cartella giusta. Da quando ce l'ha, basta calcolare qui
  // il percorso della cartella (stesse regole di attachHomes in archive.js)
  // e restituirlo già pronto: il frontend fa solo `/documenti/${folderPath}`.
  function folderPathFor(d) {
    if (d.site_id)           return `cantieri/${d.site_id}`;
    if (d.worker_id)         return `lavoratori/${d.worker_id}`;
    if (d.subcontractor_id)  return `subappaltatori/${d.subcontractor_id}`;
    if (d.equipment_id)      return `mezzi/${d.equipment_id}`;
    if (d.owner_type === 'company') return 'azienda';
    return '';
  }

  res.json({
    sites:         (sitesRes.data      || []).map(s => ({ id: s.id, name: s.name,     address: s.address,      status: s.status,    type: 'site' })),
    workers:       (workersRes.data    || []).map(w => ({ id: w.id, name: w.full_name,                             sub: w.fiscal_code, active: w.is_active, type: 'worker' })),
    subcontractors:(subsRes.data       || []).map(s => ({ id: s.id, name: s.company_name,                          sub: s.fiscal_code, status: s.status,    type: 'subcontractor' })),
    equipment:     (equipmentRes.data  || []).map(e => ({ id: e.id, name: e.name || `${e.type} ${e.model || ''}`.trim(), sub: e.plate_or_serial || e.type,   type: 'equipment' })),
    documents:     (documentsRes.data  || []).map(d => ({ id: d.id, name: d.name, sub: d.category, type: 'document', folderPath: folderPathFor(d) })),
  });
});

module.exports = router;
