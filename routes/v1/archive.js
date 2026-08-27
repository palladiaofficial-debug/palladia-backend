'use strict';
/**
 * routes/v1/archive.js
 * Fase 2 — lettura unificata dalla tabella `documents` (Scaglioni 1+2+3: site,
 * company, worker, worker_certificates, subcontractor, payslips,
 * studio_shared_documents, studio_document_requests). Sola lettura: le
 * scritture restano sulle tabelle storiche, sincronizzate via trigger (vedi
 * migrazioni 150-158). Ogni riga porta source_table+legacy_id per instradare
 * download/elimina all'endpoint legacy giusto lato frontend.
 *
 * `ladia_document_templates` è sincronizzata in `documents` (solo per la
 * ricerca/archivio interni lato Ladia) ma va esclusa qui SEMPRE, hardcoded:
 * non ha mai una UI umana e questo endpoint restituisce tutte le righe della
 * company se il chiamante non passa `source_tables` esplicito.
 *
 * `upload_token` (studio_document_requests) è un segreto che dà accesso
 * all'endpoint pubblico non autenticato /studio/upload/:token — esposto nella
 * risposta solo quando il chiamante è CDL (req.isCdl), mai per un viewer
 * impresa anche se la riga appartiene alla sua company.
 *
 * GET /api/v1/archive/documents?site_id=&worker_id=&subcontractor_id=&
 *     source_tables=a,b&category=&expiry_status=&q=&page=&page_size=
 */

const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');
const { isFeatureEnabled } = require('../../lib/featureFlags');
const { sendDbError } = require('../../lib/httpErrors');

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
  'studio_shared_documents', 'studio_document_requests', 'equipment_documents',
]);

router.get('/archive/documents', async (req, res) => {
  const companyId = req.companyId;
  const { site_id, worker_id, subcontractor_id, equipment_id, category, expiry_status, q } = req.query;

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
      subcontractor_id, equipment_id, studio_id, name, category, bucket, file_path,
      file_path_needs_review, file_size, mime_type, expiry_date, ai_expiry_date,
      content_hash, issued_date, issuing_body, certificate_number, course_type_id,
      period_year, period_month, payslip_status, notes, deleted_at, created_at, updated_at,
      request_status, due_date, response_url, response_filename, response_notes,
      reviewer_notes, upload_token,
      sites(name), workers(full_name), subcontractors(company_name), course_types(name), equipment(name)
    `, { count: 'exact' })
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .neq('source_table', 'ladia_document_templates')
    .order('created_at', { ascending: false })
    .range(from, to);

  if (site_id)           query = query.eq('site_id', site_id);
  if (worker_id)         query = query.eq('worker_id', worker_id);
  if (subcontractor_id)  query = query.eq('subcontractor_id', subcontractor_id);
  if (equipment_id)      query = query.eq('equipment_id', equipment_id);
  if (category)           query = query.eq('category', category);
  if (sourceTables?.length) query = query.in('source_table', sourceTables);
  if (q)                  query = query.ilike('name', `%${q}%`);

  const { data, error, count } = await query;
  if (error) return sendDbError(res, error);

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
      course_type_name:    d.course_types?.name || null,
      equipment_name:      d.equipment?.name || null,
      expiry_status:       status,
      upload_token:        req.isCdl ? d.upload_token : null,
      sites: undefined, workers: undefined, subcontractors: undefined, course_types: undefined, equipment: undefined,
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

// ─────────────────────────────────────────────────────────────────────────────
// Cartelle Intelligenti — navigazione a cartelle sopra la stessa tabella
// unificata `documents` usata da /archive/documents. Una "casa primaria" è
// sempre derivabile dalle colonne esistenti (owner_type/site_id/worker_id/
// category) — zero nuova tabella per quella parte. `document_extra_homes`
// (migrazione 162) copre solo le case AGGIUNTIVE (es. un DURC aziendale che
// vive anche nel fascicolo di un cantiere).
// ─────────────────────────────────────────────────────────────────────────────

const FORMAZIONE_CATEGORIES = ['certificato_formazione', 'attestato_formazione'];

function expiryStatusFor(doc, ora, presto) {
  const scad = doc.expiry_date || doc.ai_expiry_date;
  return !scad ? 'senza_scadenza' : scad < ora ? 'scaduto' : scad < presto ? 'in_scadenza' : 'valido';
}

function baseDocsQuery(companyId) {
  return supabase
    .from('documents')
    .select('id, source_table, legacy_id, owner_type, site_id, worker_id, subcontractor_id, equipment_id, category, name, expiry_date, ai_expiry_date, created_at')
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .neq('source_table', 'ladia_document_templates');
}

// GET /api/v1/document-folders — cartelle radice con conteggi
router.get('/document-folders', async (req, res) => {
  const companyId = req.companyId;
  const { data: docs, error } = await baseDocsQuery(companyId);
  if (error) return sendDbError(res, error);

  const { data: sites }   = await supabase.from('sites').select('id').eq('company_id', companyId);
  const { data: workers } = await supabase.from('workers').select('id').eq('company_id', companyId).eq('is_active', true);
  const { data: subs }    = await supabase.from('subcontractors').select('id').eq('company_id', companyId).eq('is_active', true);
  // 'mezzi' è il primo Scaglione aggiunto dopo che /documenti era già in
  // produzione per gli altri — a differenza di quelli, qui il flag va
  // controllato anche lato backend: altrimenti la cartella comparirebbe subito
  // per ogni azienda al deploy, non solo per chi l'ha verificata dal vivo.
  const equipmentEnabled = await isFeatureEnabled(companyId, 'document_hub_entry_equipment');
  const { data: equip }  = equipmentEnabled
    ? await supabase.from('equipment').select('id').eq('company_id', companyId).eq('is_active', true)
    : { data: [] };

  const ora = today(), presto = futureDate(30);
  const scaduti = (docs || []).filter(d => {
    const s = expiryStatusFor(d, ora, presto);
    return s === 'scaduto' || s === 'in_scadenza';
  }).length;

  const folders = [
    { type: 'cantieri',       count: (sites || []).length },
    { type: 'lavoratori',     count: (workers || []).length },
    { type: 'subappaltatori', count: (subs || []).length },
    { type: 'azienda',        count: (docs || []).filter(d => d.owner_type === 'company').length },
    { type: 'buste-paga',     count: (docs || []).filter(d => d.category === 'busta_paga').length },
    { type: 'formazione',     count: (docs || []).filter(d => FORMAZIONE_CATEGORIES.includes(d.category)).length },
    { type: 'scaduti',        count: scaduti, smart: true },
  ];
  if (equipmentEnabled) folders.push({ type: 'mezzi', count: (equip || []).length });

  res.json({ folders });
});

const ENTITY_FOLDER_TYPES = {
  cantieri:       { table: 'sites',          nameField: 'name',         keyField: 'site_id',          activeOnly: false },
  lavoratori:     { table: 'workers',        nameField: 'full_name',    keyField: 'worker_id',         activeOnly: true },
  subappaltatori: { table: 'subcontractors', nameField: 'company_name', keyField: 'subcontractor_id',  activeOnly: true },
  mezzi:          { table: 'equipment',      nameField: 'name',         keyField: 'equipment_id',      activeOnly: true },
};

// GET /api/v1/document-folders/:type — sottocartelle (cantieri, lavoratori o subappaltatori)
router.get('/document-folders/:type', async (req, res) => {
  const companyId = req.companyId;
  const { type } = req.params;
  const cfg = ENTITY_FOLDER_TYPES[type];
  if (!cfg) return res.status(400).json({ error: 'TIPO_NON_VALIDO' });
  if (type === 'mezzi' && !(await isFeatureEnabled(companyId, 'document_hub_entry_equipment'))) {
    return res.status(400).json({ error: 'TIPO_NON_VALIDO' });
  }

  const { data: docs, error } = await baseDocsQuery(companyId);
  if (error) return sendDbError(res, error);

  const ora = today(), presto = futureDate(30);
  const byKey = new Map();
  for (const d of (docs || [])) {
    const key = d[cfg.keyField];
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { count: 0, worstStatus: 'senza_scadenza' });
    const entry = byKey.get(key);
    entry.count += 1;
    const status = expiryStatusFor(d, ora, presto);
    if (status === 'scaduto') entry.worstStatus = 'scaduto';
    else if (status === 'in_scadenza' && entry.worstStatus !== 'scaduto') entry.worstStatus = 'in_scadenza';
  }

  let entityQuery = supabase.from(cfg.table).select(`id, ${cfg.nameField}`).eq('company_id', companyId);
  if (cfg.activeOnly) entityQuery = entityQuery.eq('is_active', true);
  const { data: entities, error: entErr } = await entityQuery;
  if (entErr) return res.status(500).json({ error: 'DB_ERROR', detail: entErr.message });

  const items = (entities || []).map(e => {
    const entry = byKey.get(e.id) || { count: 0, worstStatus: 'senza_scadenza' };
    return { key: e.id, name: e[cfg.nameField], count: entry.count, status: entry.worstStatus };
  });

  res.json({ type, items });
});

// GET /api/v1/document-folders/:type/:key/documents — file dentro una cartella
router.get('/document-folders/:type/:key/documents', async (req, res) => {
  const companyId = req.companyId;
  const { type, key } = req.params;

  // Cartella smart: nessuna "casa" reale, calcolata al volo sulla scadenza —
  // niente logica di document_extra_homes qui, :key è ignorato (sempre 'tutti').
  if (type === 'scaduti') {
    const { data: docs, error } = await baseDocsQueryFull(companyId);
    if (error) return sendDbError(res, error);
    const ora = today(), presto = futureDate(30);
    const scaduti = (docs || []).filter(d => {
      const s = expiryStatusFor(d, ora, presto);
      return s === 'scaduto' || s === 'in_scadenza';
    });
    return res.json({ type, key, documents: await attachHomes(scaduti) });
  }

  if (type === 'mezzi' && !(await isFeatureEnabled(companyId, 'document_hub_entry_equipment'))) {
    return res.status(400).json({ error: 'TIPO_NON_VALIDO' });
  }

  let primaryQuery = baseDocsQueryFull(companyId);
  if (type === 'cantieri')            primaryQuery = primaryQuery.eq('site_id', key);
  else if (type === 'lavoratori')     primaryQuery = primaryQuery.eq('worker_id', key);
  else if (type === 'subappaltatori') primaryQuery = primaryQuery.eq('subcontractor_id', key);
  else if (type === 'mezzi')          primaryQuery = primaryQuery.eq('equipment_id', key);
  else if (type === 'azienda')        primaryQuery = primaryQuery.eq('owner_type', 'company');
  else if (type === 'buste-paga')     primaryQuery = primaryQuery.eq('category', 'busta_paga');
  else if (type === 'formazione')     primaryQuery = primaryQuery.in('category', FORMAZIONE_CATEGORIES);
  else return res.status(400).json({ error: 'TIPO_NON_VALIDO' });

  const { data: primaryDocs, error: primaryErr } = await primaryQuery;
  if (primaryErr) return res.status(500).json({ error: 'DB_ERROR', detail: primaryErr.message });

  // Documenti la cui casa in questa cartella è AGGIUNTIVA (document_extra_homes)
  // — i subappaltatori e i mezzi non supportano ancora case extra, solo browsing.
  const extraFolderType = type === 'cantieri' ? 'site' : type === 'lavoratori' ? 'worker' : (type === 'subappaltatori' || type === 'mezzi') ? null : 'category';
  const { data: extraLinks } = extraFolderType
    ? await supabase.from('document_extra_homes').select('document_id').eq('folder_type', extraFolderType).eq('folder_key', key)
    : { data: [] };

  const extraIds = [...new Set((extraLinks || []).map(l => l.document_id))];
  const primaryIds = new Set((primaryDocs || []).map(d => d.id));
  const missingExtraIds = extraIds.filter(id => !primaryIds.has(id));

  let extraDocs = [];
  if (missingExtraIds.length) {
    const { data } = await baseDocsQueryFull(companyId).in('id', missingExtraIds);
    extraDocs = data || [];
  }

  const allDocs = [...(primaryDocs || []), ...extraDocs];
  res.json({ type, key, documents: await attachHomes(allDocs) });
});

function baseDocsQueryFull(companyId) {
  return supabase
    .from('documents')
    .select(`
      id, source_table, legacy_id, owner_type, company_id, site_id, worker_id,
      subcontractor_id, equipment_id, name, category, bucket, file_path, file_size, mime_type,
      expiry_date, ai_expiry_date, content_hash, issued_date, issuing_body,
      certificate_number, course_type_id, period_year, period_month, payslip_status,
      notes, deleted_at, created_at, updated_at,
      sites(name), workers(full_name), subcontractors(company_name), course_types(name), equipment(name)
    `)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .neq('source_table', 'ladia_document_templates');
}

// Arricchisce ogni documento con `expiry_status` e la lista di TUTTE le sue
// case (primaria + eventuali extra) per il badge "vive anche in" in UI.
async function attachHomes(docs) {
  if (!docs.length) return [];
  const ora = today(), presto = futureDate(30);
  const ids = docs.map(d => d.id);
  const { data: allExtra } = await supabase
    .from('document_extra_homes')
    .select('id, document_id, folder_type, folder_key')
    .in('document_id', ids);

  const extraByDoc = new Map();
  for (const link of (allExtra || [])) {
    if (!extraByDoc.has(link.document_id)) extraByDoc.set(link.document_id, []);
    extraByDoc.get(link.document_id).push({ id: link.id, type: link.folder_type, key: link.folder_key, extra: true });
  }

  return docs.map(d => {
    // homeId: null per le case primarie (derivate dalle colonne del documento,
    // niente riga da rimuovere) — solo le case extra hanno un id reale che il
    // frontend può passare a DELETE /documents/:id/homes/:homeId.
    const homes = [];
    if (d.site_id)   homes.push({ id: null, type: 'site', key: d.site_id, extra: false });
    if (d.worker_id) homes.push({ id: null, type: 'worker', key: d.worker_id, extra: false });
    if (d.subcontractor_id) homes.push({ id: null, type: 'subcontractor', key: d.subcontractor_id, extra: false });
    if (d.equipment_id) homes.push({ id: null, type: 'equipment', key: d.equipment_id, extra: false });
    if (d.owner_type === 'company') homes.push({ id: null, type: 'category', key: 'azienda', extra: false });
    if (d.category === 'busta_paga') homes.push({ id: null, type: 'category', key: 'buste-paga', extra: false });
    if (FORMAZIONE_CATEGORIES.includes(d.category)) homes.push({ id: null, type: 'category', key: 'formazione', extra: false });
    for (const extra of (extraByDoc.get(d.id) || [])) homes.push(extra);

    return {
      ...d,
      site_name:     d.sites?.name || null,
      worker_name:   d.workers?.full_name || null,
      subcontractor_name: d.subcontractors?.company_name || null,
      course_type_name: d.course_types?.name || null,
      equipment_name: d.equipment?.name || null,
      expiry_status: expiryStatusFor(d, ora, presto),
      homes,
      sites: undefined, workers: undefined, subcontractors: undefined, course_types: undefined, equipment: undefined,
    };
  });
}

// POST /api/v1/documents/:id/homes — aggiungi una casa extra a mano
router.post('/documents/:id/homes', async (req, res) => {
  const companyId = req.companyId;
  const { folder_type, folder_key } = req.body || {};
  if (!['site', 'worker', 'category'].includes(folder_type) || !folder_key)
    return res.status(400).json({ error: 'PARAMETRI_NON_VALIDI' });

  const { data: doc } = await supabase.from('documents').select('id').eq('id', req.params.id).eq('company_id', companyId).maybeSingle();
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data, error } = await supabase.from('document_extra_homes').upsert({
    document_id: req.params.id, folder_type, folder_key, added_by: req.user.id,
  }, { onConflict: 'document_id,folder_type,folder_key', ignoreDuplicates: true }).select('id').maybeSingle();
  if (error) return sendDbError(res, error);

  res.json({ ok: true, id: data?.id || null });
});

// DELETE /api/v1/documents/:id/homes/:homeId — rimuovi una casa extra
router.delete('/documents/:id/homes/:homeId', async (req, res) => {
  const companyId = req.companyId;
  const { data: doc } = await supabase.from('documents').select('id').eq('id', req.params.id).eq('company_id', companyId).maybeSingle();
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  const { error } = await supabase.from('document_extra_homes').delete().eq('id', req.params.homeId).eq('document_id', req.params.id);
  if (error) return sendDbError(res, error);

  res.json({ ok: true });
});

module.exports = router;
