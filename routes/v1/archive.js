'use strict';
/**
 * routes/v1/archive.js
 * Fase 2 — lettura unificata dalla tabella `documents` (Scaglioni 1+2: site,
 * company, worker, worker_certificates, subcontractor, payslips). Sola
 * lettura: le scritture restano sulle tabelle storiche, sincronizzate via
 * trigger (vedi migrazioni 150-155). Ogni riga porta source_table+legacy_id
 * per instradare download/elimina all'endpoint legacy giusto lato frontend.
 *
 * GET /api/v1/archive/documents?site_id=&worker_id=&subcontractor_id=&
 *     source_tables=a,b&category=&expiry_status=&q=&page=&page_size=
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

router.use(verifySupabaseJwt);

function today() {
  return new Date().toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
}
function futureDate(days) {
  return new Date(Date.now() + Number(days) * 86400000).toLocaleDateString('sv', { timeZone: 'Europe/Rome' });
}

const KNOWN_SOURCE_TABLES = new Set([
  'site_documents', 'company_documents', 'worker_documents',
  'worker_certificates', 'subcontractor_documents', 'payslips',
]);

router.get('/archive/documents', async (req, res) => {
  const companyId = req.companyId;
  const { site_id, worker_id, subcontractor_id, category, expiry_status, q } = req.query;

  const sourceTables = req.query.source_tables
    ? String(req.query.source_tables).split(',').map(s => s.trim()).filter(s => KNOWN_SOURCE_TABLES.has(s))
    : null;

  const page     = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 50));
  const from     = (page - 1) * pageSize;
  const to       = from + pageSize - 1;

  let query = supabase
    .from('documents')
    .select(`
      id, source_table, legacy_id, owner_type, company_id, site_id, worker_id,
      subcontractor_id, studio_id, name, category, bucket, file_path,
      file_path_needs_review, file_size, mime_type, expiry_date, ai_expiry_date,
      content_hash, issued_date, issuing_body, certificate_number, course_type_id,
      period_year, period_month, payslip_status, notes, deleted_at, created_at, updated_at,
      sites(name), workers(full_name), subcontractors(company_name)
    `, { count: 'exact' })
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (site_id)           query = query.eq('site_id', site_id);
  if (worker_id)         query = query.eq('worker_id', worker_id);
  if (subcontractor_id)  query = query.eq('subcontractor_id', subcontractor_id);
  if (category)           query = query.eq('category', category);
  if (sourceTables?.length) query = query.in('source_table', sourceTables);
  if (q)                  query = query.ilike('name', `%${q}%`);

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  const ora    = today();
  const presto = futureDate(30);

  let results = (data || []).map(d => {
    const scad   = d.expiry_date || d.ai_expiry_date;
    const status = !scad ? 'senza_scadenza' : scad < ora ? 'scaduto' : scad < presto ? 'in_scadenza' : 'valido';
    return {
      ...d,
      site_name:           d.sites?.name || null,
      worker_name:         d.workers?.full_name || null,
      subcontractor_name:  d.subcontractors?.company_name || null,
      expiry_status:       status,
      sites: undefined, workers: undefined, subcontractors: undefined,
    };
  });

  // Nota: il filtro per stato scadenza è applicato dopo la paginazione lato DB
  // (COALESCE su 2 colonne non è comodamente filtrabile col query builder) —
  // su una pagina molto filtrata può restituire meno di page_size righe.
  // Accettabile per questo step (parità con le viste legacy, non ricerca
  // full-text avanzata — quella è prevista per l'archivio finale).
  if (expiry_status) results = results.filter(r => r.expiry_status === expiry_status);

  res.json({ results, total: count ?? results.length, page, page_size: pageSize });
});

module.exports = router;
