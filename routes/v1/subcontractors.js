'use strict';
const crypto   = require('crypto');
const multer   = require('multer');
const router   = require('express').Router();
const supabase = require('../../lib/supabase');
const { verifySupabaseJwt } = require('../../middleware/verifyJwt');

// ── Upload configurazione documenti subappaltatori ────────────────────────────
const BUCKET       = 'site-documents'; // stesso bucket usato da companyDocuments e documents
const MAX_SIZE     = 20 * 1024 * 1024; // 20 MB
const SUB_DOC_CATS = ['durc', 'insurance', 'soa', 'visura', 'iso', 'f24', 'altro'];

function safeName(n) {
  return String(n || 'file').replace(/[^a-z0-9.\-_]/gi, '_').slice(0, 100);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
      .includes(file.mimetype);
    cb(ok ? null : new Error('INVALID_FILE_TYPE'), ok);
  },
});

async function analyzeSubDoc(docId, filePath, mimeType) {
  try {
    const { analyzeSubcontractorDocBuffer } = require('../../services/documentAI');
    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, 300);
    if (!signed?.signedUrl) return;
    const resp   = await fetch(signed.signedUrl);
    const buf    = Buffer.from(await resp.arrayBuffer());
    const result = await analyzeSubcontractorDocBuffer(buf, mimeType);
    if (!result) return;
    await supabase.from('subcontractor_documents').update({
      ai_summary:     result.summary     || null,
      ai_expiry_date: result.expiry_date || null,
      ai_issues:      result.issues      || [],
      ai_validity_ok: result.validity_ok ?? null,
      ai_analyzed_at: new Date().toISOString(),
    }).eq('id', docId);
  } catch (e) {
    console.error('[analyzeSubDoc]', e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SELECT_COLS =
  'id, company_name, piva, legal_address, contact_person, phone, email, ' +
  'durc_expiry, visura_date, insurance_expiry, soa_expiry, f24_quarter, ' +
  'notify_expiry, is_active, notes, created_at, updated_at';

// Stato compliance calcolato lato backend in base alle scadenze
function computeStatus(sub) {
  const today = Date.now();
  const daysUntil = (d) => d ? Math.floor((new Date(d) - today) / 86_400_000) : null;
  const days = [
    daysUntil(sub.durc_expiry),
    daysUntil(sub.insurance_expiry),
    daysUntil(sub.soa_expiry),
  ].filter((d) => d !== null);

  if (days.some((d) => d < 0))   return 'non_compliant';
  if (days.some((d) => d <= 30)) return 'expiring';
  return 'compliant';
}

function format(sub) {
  return { ...sub, status: computeStatus(sub) };
}

function isValidDate(v) {
  if (!v || v === '') return true; // vuoto = cancella
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// ── GET /api/v1/subcontractors ────────────────────────────────────────────────
router.get('/subcontractors', verifySupabaseJwt, async (req, res) => {
  const includeArchived = req.query.archived === 'true';
  let query = supabase
    .from('subcontractors')
    .select(SELECT_COLS)
    .eq('company_id', req.companyId)
    .order('company_name', { ascending: true });

  if (!includeArchived) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json((data || []).map(format));
});

// ── POST /api/v1/subcontractors ───────────────────────────────────────────────
router.post('/subcontractors', verifySupabaseJwt, async (req, res) => {
  const {
    company_name, piva, legal_address, contact_person,
    phone, email, durc_expiry, visura_date, insurance_expiry,
    soa_expiry, f24_quarter, notify_expiry, notes,
  } = req.body;

  if (!company_name || !String(company_name).trim())
    return res.status(400).json({ error: 'COMPANY_NAME_REQUIRED' });

  const dateFields = { durc_expiry, visura_date, insurance_expiry, soa_expiry };
  for (const [k, v] of Object.entries(dateFields)) {
    if (!isValidDate(v)) return res.status(400).json({ error: `INVALID_DATE_${k.toUpperCase()}` });
  }

  const { data, error } = await supabase
    .from('subcontractors')
    .insert([{
      company_id:      req.companyId,
      company_name:    String(company_name).trim().slice(0, 200),
      piva:            piva            ? String(piva).trim().slice(0, 20)  : null,
      legal_address:   legal_address  ? String(legal_address).trim().slice(0, 300) : null,
      contact_person:  contact_person ? String(contact_person).trim().slice(0, 150) : null,
      phone:           phone          ? String(phone).trim().slice(0, 30)  : null,
      email:           email          ? String(email).trim().slice(0, 150) : null,
      durc_expiry:     durc_expiry     || null,
      visura_date:     visura_date     || null,
      insurance_expiry: insurance_expiry || null,
      soa_expiry:      soa_expiry      || null,
      f24_quarter:     f24_quarter    ? String(f24_quarter).trim().slice(0, 20) : null,
      notify_expiry:   notify_expiry !== false,
      notes:           notes          ? String(notes).trim().slice(0, 1000) : null,
    }])
    .select(SELECT_COLS)
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.status(201).json(format(data));
});

// ── PATCH /api/v1/subcontractors/:id ─────────────────────────────────────────
router.patch('/subcontractors/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;

  const { data: existing } = await supabase
    .from('subcontractors')
    .select('id')
    .eq('id', id).eq('company_id', req.companyId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const allowed = [
    'company_name', 'piva', 'legal_address', 'contact_person',
    'phone', 'email', 'durc_expiry', 'visura_date', 'insurance_expiry',
    'soa_expiry', 'f24_quarter', 'notify_expiry', 'notes', 'is_active',
  ];
  const patch = {};
  for (const k of allowed) {
    if (k in req.body) patch[k] = req.body[k] ?? null;
  }
  if (Object.keys(patch).length === 0)
    return res.status(400).json({ error: 'NO_FIELDS' });

  const dateFields = ['durc_expiry', 'visura_date', 'insurance_expiry', 'soa_expiry'];
  for (const k of dateFields) {
    if (k in patch && !isValidDate(patch[k]))
      return res.status(400).json({ error: `INVALID_DATE_${k.toUpperCase()}` });
  }

  const { data, error } = await supabase
    .from('subcontractors')
    .update(patch)
    .eq('id', id).eq('company_id', req.companyId)
    .select(SELECT_COLS)
    .single();

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });
  res.json(format(data));
});

// ── DELETE /api/v1/subcontractors/:id — soft delete (archivia) ───────────────
router.delete('/subcontractors/:id', verifySupabaseJwt, async (req, res) => {
  const { id } = req.params;

  const { data: existing } = await supabase
    .from('subcontractors')
    .select('id')
    .eq('id', id).eq('company_id', req.companyId).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

  const { error } = await supabase
    .from('subcontractors')
    .update({ is_active: false })
    .eq('id', id).eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── Assegnazione subappaltatori a cantiere ─────────────────────────────────────

router.get('/sites/:siteId/subcontractors', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { data: site } = await supabase.from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data, error } = await supabase
    .from('site_subcontractors')
    .select('id, subcontractor_id, role, assigned_at, subcontractor:subcontractor_id(company_name, piva, contact_person, phone, email, durc_expiry, insurance_expiry, soa_expiry, is_active)')
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .order('assigned_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const result = (data || [])
    .filter(r => r.subcontractor?.is_active !== false)
    .map(r => ({
      id:               r.id,
      subcontractor_id: r.subcontractor_id,
      role:             r.role,
      assigned_at:      r.assigned_at,
      company_name:     r.subcontractor?.company_name || '',
      piva:             r.subcontractor?.piva         || '',
      contact_person:   r.subcontractor?.contact_person || '',
      phone:            r.subcontractor?.phone        || '',
      email:            r.subcontractor?.email        || '',
      status:           computeStatus(r.subcontractor || {}),
    }));

  res.json(result);
});

router.post('/sites/:siteId/subcontractors', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;
  const { subcontractor_id, role } = req.body;
  if (!subcontractor_id) return res.status(400).json({ error: 'SUBCONTRACTOR_ID_REQUIRED' });

  const { data: site } = await supabase.from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(404).json({ error: 'NOT_FOUND' });

  const { error } = await supabase.from('site_subcontractors').insert([{
    company_id: req.companyId, site_id: siteId, subcontractor_id, role: role || null,
  }]);
  if (error?.code === '23505') return res.status(409).json({ error: 'ALREADY_ASSIGNED' });
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ ok: true });
});

router.delete('/sites/:siteId/subcontractors/:assignId', verifySupabaseJwt, async (req, res) => {
  const { siteId, assignId } = req.params;
  const { error } = await supabase
    .from('site_subcontractors').delete()
    .eq('id', assignId).eq('site_id', siteId).eq('company_id', req.companyId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── ENTERPRISE: Documenti per subappaltatore ──────────────────────────────────

// Verifica ownership del sub (helper)
async function getOwnedSub(subId, companyId) {
  const { data } = await supabase
    .from('subcontractors').select('id')
    .eq('id', subId).eq('company_id', companyId).maybeSingle();
  return data;
}

// GET /api/v1/subcontractors/:id/documents
router.get('/subcontractors/:id/documents', verifySupabaseJwt, async (req, res) => {
  if (!await getOwnedSub(req.params.id, req.companyId))
    return res.status(404).json({ error: 'NOT_FOUND' });

  const { data, error } = await supabase
    .from('subcontractor_documents')
    .select('id, name, category, file_size, mime_type, valid_until, ai_summary, ai_expiry_date, ai_issues, ai_validity_ok, ai_analyzed_at, created_at')
    .eq('subcontractor_id', req.params.id)
    .eq('company_id', req.companyId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// POST /api/v1/subcontractors/:id/documents
router.post('/subcontractors/:id/documents',
  verifySupabaseJwt,
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError)
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : err.message });
    if (err) return res.status(400).json({ error: err.message });
    next();
  }),
  async (req, res) => {
    if (!await getOwnedSub(req.params.id, req.companyId))
      return res.status(404).json({ error: 'NOT_FOUND' });
    if (!req.file) return res.status(400).json({ error: 'FILE_REQUIRED' });

    const category = req.body.category || 'altro';
    if (!SUB_DOC_CATS.includes(category))
      return res.status(400).json({ error: 'INVALID_CATEGORY', valid: SUB_DOC_CATS });

    const fileId   = crypto.randomUUID();
    const filename = safeName(req.file.originalname);
    const filePath = `${req.companyId}/subcontractors/${req.params.id}/${fileId}-${filename}`;

    const { error: storageErr } = await supabase.storage
      .from(BUCKET).upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (storageErr) return res.status(500).json({ error: 'UPLOAD_ERROR', detail: storageErr.message });

    const { data: doc, error: dbErr } = await supabase
      .from('subcontractor_documents')
      .insert([{
        company_id:       req.companyId,
        subcontractor_id: req.params.id,
        name:             req.file.originalname.slice(0, 500),
        category,
        file_path:        filePath,
        file_size:        req.file.size,
        mime_type:        req.file.mimetype,
        valid_until:      req.body.valid_until || null,
        uploaded_by:      req.user?.id || null,
      }])
      .select('id, name, category, file_size, mime_type, created_at')
      .single();

    if (dbErr) {
      await supabase.storage.from(BUCKET).remove([filePath]).catch(() => {});
      return res.status(500).json({ error: 'DB_ERROR' });
    }

    // AI analisi in background
    analyzeSubDoc(doc.id, filePath, req.file.mimetype).catch(() => {});

    res.status(201).json({ ok: true, document: doc });
  }
);

// GET /api/v1/subcontractors/:id/documents/:docId/download
router.get('/subcontractors/:id/documents/:docId/download', verifySupabaseJwt, async (req, res) => {
  const { data: doc } = await supabase
    .from('subcontractor_documents')
    .select('file_path')
    .eq('id', req.params.docId)
    .eq('subcontractor_id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  const { data: signed, error } = await supabase.storage
    .from(BUCKET).createSignedUrl(doc.file_path, 3600);
  if (error || !signed) return res.status(500).json({ error: 'SIGNED_URL_ERROR' });
  res.json({ url: signed.signedUrl });
});

// POST /api/v1/subcontractors/:id/documents/:docId/analyze
router.post('/subcontractors/:id/documents/:docId/analyze', verifySupabaseJwt, async (req, res) => {
  const { data: doc } = await supabase
    .from('subcontractor_documents')
    .select('id, file_path, mime_type')
    .eq('id', req.params.docId)
    .eq('subcontractor_id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  await supabase.from('subcontractor_documents')
    .update({ ai_analyzed_at: null }).eq('id', doc.id);

  analyzeSubDoc(doc.id, doc.file_path, doc.mime_type).catch(() => {});
  res.json({ ok: true, message: 'Analisi avviata' });
});

// DELETE /api/v1/subcontractors/:id/documents/:docId
router.delete('/subcontractors/:id/documents/:docId', verifySupabaseJwt, async (req, res) => {
  const { data: doc } = await supabase
    .from('subcontractor_documents')
    .select('id, file_path')
    .eq('id', req.params.docId)
    .eq('subcontractor_id', req.params.id)
    .eq('company_id', req.companyId)
    .maybeSingle();
  if (!doc) return res.status(404).json({ error: 'NOT_FOUND' });

  if (doc.file_path) {
    await supabase.storage.from(BUCKET).remove([doc.file_path]).catch(() => {});
  }
  const { error } = await supabase
    .from('subcontractor_documents').delete().eq('id', doc.id);
  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── ENTERPRISE: Lavoratori del subappaltatore ─────────────────────────────────

// GET /api/v1/subcontractors/:id/workers
router.get('/subcontractors/:id/workers', verifySupabaseJwt, async (req, res) => {
  if (!await getOwnedSub(req.params.id, req.companyId))
    return res.status(404).json({ error: 'NOT_FOUND' });

  const { data, error } = await supabase
    .from('workers')
    .select('id, full_name, fiscal_code, is_active, qualification, hire_date')
    .eq('company_id', req.companyId)
    .eq('subcontractor_id', req.params.id)
    .order('full_name');

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json(data || []);
});

// PATCH /api/v1/workers/:workerId/subcontractor — collega un lavoratore a un sub
router.patch('/workers/:workerId/subcontractor', verifySupabaseJwt, async (req, res) => {
  const { subcontractor_id } = req.body;

  // Verifica che il lavoratore appartenga alla company
  const { data: worker } = await supabase
    .from('workers').select('id')
    .eq('id', req.params.workerId).eq('company_id', req.companyId).maybeSingle();
  if (!worker) return res.status(404).json({ error: 'NOT_FOUND' });

  // Verifica subappaltatore (se specificato)
  if (subcontractor_id) {
    const sub = await getOwnedSub(subcontractor_id, req.companyId);
    if (!sub) return res.status(404).json({ error: 'SUBCONTRACTOR_NOT_FOUND' });
  }

  const { error } = await supabase
    .from('workers')
    .update({ subcontractor_id: subcontractor_id || null })
    .eq('id', req.params.workerId).eq('company_id', req.companyId);

  if (error) return res.status(500).json({ error: 'DB_ERROR' });
  res.json({ ok: true });
});

// ── ENTERPRISE: Forza lavoro completa di un cantiere ─────────────────────────
// GET /api/v1/sites/:siteId/workforce
router.get('/sites/:siteId/workforce', verifySupabaseJwt, async (req, res) => {
  const { siteId } = req.params;

  // Verifica ownership cantiere
  const { data: site } = await supabase
    .from('sites').select('id').eq('id', siteId).eq('company_id', req.companyId).maybeSingle();
  if (!site) return res.status(404).json({ error: 'NOT_FOUND' });

  // Recupera tutti i lavoratori attivi sul cantiere con info subappaltatore
  const { data: workforce, error } = await supabase
    .from('worksite_workers')
    .select(`
      worker_id,
      status,
      workers!inner (
        id, full_name, fiscal_code, is_active, qualification,
        subcontractor_id,
        subcontractors (
          id, company_name, durc_expiry, insurance_expiry, soa_expiry, is_active
        )
      )
    `)
    .eq('site_id', siteId)
    .eq('company_id', req.companyId)
    .eq('status', 'active');

  if (error) return res.status(500).json({ error: 'DB_ERROR', detail: error.message });

  const today = Date.now();
  function subStatus(sub) {
    if (!sub) return null;
    const daysUntil = (d) => d ? Math.floor((new Date(d) - today) / 86_400_000) : null;
    const days = [daysUntil(sub.durc_expiry), daysUntil(sub.insurance_expiry), daysUntil(sub.soa_expiry)]
      .filter(d => d !== null);
    if (days.some(d => d < 0))   return 'non_compliant';
    if (days.some(d => d <= 30)) return 'expiring';
    return 'compliant';
  }

  // Recupera ultima timbratura per ogni lavoratore (oggi)
  const workerIds = (workforce || []).map(r => r.worker_id);
  let lastPunches = {};
  if (workerIds.length > 0) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { data: punches } = await supabase
      .from('presence_logs')
      .select('worker_id, event_type, timestamp_server')
      .eq('site_id', siteId)
      .eq('company_id', req.companyId)
      .in('worker_id', workerIds)
      .gte('timestamp_server', todayStart.toISOString())
      .order('timestamp_server', { ascending: false });

    for (const punch of (punches || [])) {
      if (!lastPunches[punch.worker_id]) {
        lastPunches[punch.worker_id] = punch;
      }
    }
  }

  const workers = (workforce || []).map(r => {
    const w   = r.workers;
    const sub = w.subcontractors;
    const lastP = lastPunches[w.id];
    return {
      id:                  w.id,
      full_name:           w.full_name,
      fiscal_code:         w.fiscal_code,
      qualification:       w.qualification,
      company_type:        sub ? 'subcontractor' : 'direct',
      subcontractor_id:    w.subcontractor_id,
      subcontractor_name:  sub?.company_name || null,
      subcontractor_status: subStatus(sub),
      is_present_today:    lastP?.event_type === 'ENTRY',
      last_event_type:     lastP?.event_type || null,
      last_punch:          lastP?.timestamp_server || null,
    };
  });

  // Raggruppa per subappaltatore
  const subMap = {};
  for (const w of workers) {
    if (w.subcontractor_id) {
      if (!subMap[w.subcontractor_id]) {
        subMap[w.subcontractor_id] = {
          id:              w.subcontractor_id,
          company_name:    w.subcontractor_name,
          status:          w.subcontractor_status,
          workers_count:   0,
          workers_present: 0,
        };
      }
      subMap[w.subcontractor_id].workers_count++;
      if (w.is_present_today) subMap[w.subcontractor_id].workers_present++;
    }
  }

  res.json({
    workers,
    summary: {
      total:           workers.length,
      direct:          workers.filter(w => w.company_type === 'direct').length,
      subcontractors:  workers.filter(w => w.company_type === 'subcontractor').length,
      present_today:   workers.filter(w => w.is_present_today).length,
    },
    subcontractors: Object.values(subMap),
  });
});

module.exports = router;
